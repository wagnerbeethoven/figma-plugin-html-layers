figma.showUI(__html__, { width: 560, height: 620, title: 'HTMLayers' });

const TAG_KEY = 'html_tag';

interface RenameOptions {
  includeOriginalName: boolean;
  numberSiblings: boolean;
  separator: string;
  pathMode: 'full' | 'leaf';
}

let opts: RenameOptions = {
  includeOriginalName: false,
  numberSiblings: false,
  separator: ' > ',
  pathMode: 'full',
};

function getDefaultTag(node: SceneNode): string {
  switch (node.type) {
    case 'TEXT': return 'span';
    case 'VECTOR': case 'BOOLEAN_OPERATION': case 'STAR':
    case 'LINE': case 'ELLIPSE': case 'POLYGON': return 'svg';
    case 'RECTANGLE': return 'div';
    case 'INSTANCE': return 'div';
    case 'COMPONENT': case 'COMPONENT_SET': return 'section';
    default: return 'div';
  }
}

function storedTag(node: SceneNode): string | null {
  return node.getPluginData(TAG_KEY) || null;
}

function effectiveTag(node: SceneNode): string {
  return storedTag(node) || getDefaultTag(node);
}

// [P5] opts as explicit param — no hidden global dependency
function buildSegment(n: SceneNode, o: RenameOptions): string {
  const tag = effectiveTag(n);
  let part = tag;

  if (o.numberSiblings && n.parent && 'children' in n.parent) {
    const par = n.parent as BaseNode & { children: readonly SceneNode[] };
    if (par.type !== 'PAGE' && par.type !== 'DOCUMENT') {
      const same = par.children.filter(s => effectiveTag(s as SceneNode) === tag);
      if (same.length > 1) {
        part += ` · ${same.findIndex(s => s.id === n.id) + 1}`;
      }
    }
  }

  if (o.includeOriginalName) {
    const orig = n.name.trim();
    if (orig && orig !== tag) part += ` [${orig}]`;
  }

  return part;
}

function buildPath(node: SceneNode, o: RenameOptions): string {
  if (o.pathMode === 'leaf') {
    return buildSegment(node, o);
  }

  const parts: string[] = [];
  let cur: BaseNode = node;

  while (cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    // [B4] guard: only call buildSegment on real SceneNodes (have getPluginData)
    if ('getPluginData' in cur) {
      parts.unshift(buildSegment(cur as SceneNode, o));
    }
    if (!cur.parent) break;
    cur = cur.parent;
  }

  return parts.join(o.separator);
}

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  depth: number;
  storedTag: string | null;
  defaultTag: string;
  preview: string;
}

function layerInfo(node: SceneNode, depth: number): LayerInfo {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    depth,
    storedTag: storedTag(node),
    defaultTag: getDefaultTag(node),
    preview: buildPath(node, opts),
  };
}

function collectLayers(): LayerInfo[] {
  const result: LayerInfo[] = [];
  function traverse(node: SceneNode, depth: number) {
    result.push(layerInfo(node, depth));
    if ('children' in node) {
      for (const c of node.children) traverse(c as SceneNode, depth + 1);
    }
  }
  for (const n of figma.currentPage.selection) traverse(n, 0);
  return result;
}

function sendLayers() {
  figma.ui.postMessage({ type: 'layers', layers: collectLayers(), opts });
}

// [P2] debounce selectionchange — avoids spam on rubber-band select
let _selTimer: ReturnType<typeof setTimeout> | null = null;
figma.on('selectionchange', () => {
  if (_selTimer) clearTimeout(_selTimer);
  _selTimer = setTimeout(sendLayers, 80);
});

// [B3] validate opts shape received from UI
function isValidOpts(o: unknown): o is RenameOptions {
  if (!o || typeof o !== 'object') return false;
  const c = o as Record<string, unknown>;
  return (
    typeof c.includeOriginalName === 'boolean' &&
    typeof c.numberSiblings === 'boolean' &&
    typeof c.separator === 'string' && c.separator.length <= 10 &&
    (c.pathMode === 'full' || c.pathMode === 'leaf')
  );
}

// [U8] only write pluginData when tag differs from auto-default
// prevents polluting data and confusing storedTag vs defaultTag on reopen
function persistTag(node: SceneNode, tag: string): void {
  if (tag !== getDefaultTag(node)) {
    node.setPluginData(TAG_KEY, tag);
  } else {
    node.setPluginData(TAG_KEY, ''); // clear — back to default
  }
}

figma.ui.onmessage = async (msg: {
  type: string;
  id?: string;
  tag?: string;
  tags?: Array<{ id: string; tag: string }>;
  assignments?: Array<{ id: string; tag: string }>;
  opts?: unknown;
}) => {
  if (msg.type === 'init') {
    sendLayers();
    return;
  }

  if (msg.type === 'set-options') {
    if (!isValidOpts(msg.opts)) return; // [B3] reject malformed opts
    opts = msg.opts;
    sendLayers();
    return;
  }

  if (msg.type === 'set-tag' && msg.id && msg.tag) {
    const node = await figma.getNodeByIdAsync(msg.id);
    if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
      persistTag(node as SceneNode, msg.tag); // [U8]
      sendLayers();
    }
    return;
  }

  if (msg.type === 'set-tags' && msg.tags) {
    for (const t of msg.tags) {
      const node = await figma.getNodeByIdAsync(t.id);
      if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
        persistTag(node as SceneNode, t.tag); // [U8]
      }
    }
    sendLayers();
    return;
  }

  if (msg.type === 'rename-all' && msg.assignments) {
    // [B1] single pass: set pluginData + rename in same loop (no double fetch)
    let count = 0;
    for (const a of msg.assignments) {
      const node = await figma.getNodeByIdAsync(a.id);
      if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
        const sn = node as SceneNode;
        persistTag(sn, a.tag);          // [U8] only persist non-defaults
        sn.name = buildPath(sn, opts);  // rename with current opts
        count++;
      }
    }
    // [U2] send result to UI so toast uses user's selected language
    // [U1] don't close immediately — user can keep editing or close manually
    figma.ui.postMessage({ type: 'renamed', count });
    return;
  }

  if (msg.type === 'cancel' || msg.type === 'close') {
    figma.closePlugin();
  }
};
