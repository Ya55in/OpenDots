import type { WorkspaceStore } from './workspace.js';
// An allowlist: new administrative routes stay unavailable to members by default.
export async function memberRouteAllowed(request: Request, ws: WorkspaceStore) {
  const url = new URL(request.url),
    path = url.pathname.slice(4),
    method = request.method;
  if (
    method === 'GET' &&
    ['/state', '/workspace', '/session', '/routing'].includes(path)
  )
    return true;
  if (method === 'POST' && path === '/setup-telemetry') return true;
  if (path.startsWith('/copilotkit/')) return true; // validateRuntimeScope + per-user SDK identity enforce thread ownership.
  const body =
    method === 'GET'
      ? {}
      : await request
          .clone()
          .json()
          .catch(() => ({}));
  if (method === 'POST' && path === '/conversations')
    return typeof body.dotId === 'string' && !!ws.dot(body.dotId);
  const conversation = path.match(
    /^\/conversations\/([^/]+)\/(routing|decisions|capture|page-context|reviewed-page(?:\/[^/]+)?|page)$/,
  );
  if (conversation) {
    ws.requireThread(decodeURIComponent(conversation[1]));
    if (body.spaceId && !ws.spaces().some((space) => space.id === body.spaceId))
      return false;
    return ['GET', 'POST', 'PUT'].includes(method);
  }
  const space = path.match(/^\/spaces\/([^/]+)\/(.+)$/);
  if (!space) return false;
  const spaceId = decodeURIComponent(space[1]),
    tail = space[2];
  if (!ws.spaces().some((s) => s.id === spaceId)) return false;
  if (body.dotId && !ws.canAccessSpace(body.dotId, spaceId)) return false;
  if (body.threadId) ws.requireThread(body.threadId, body.dotId);
  if (/^pages\/[^/]+\/conversation$/.test(tail))
    return (
      method === 'POST' &&
      typeof body.dotId === 'string' &&
      ws.canAccessSpace(body.dotId, spaceId)
    );
  if (tail === 'pages' || /^pages\/[^/]+$/.test(tail))
    return ['GET', 'POST', 'PATCH'].includes(method);
  if (tail.startsWith('knowledge/')) return method === 'GET';
  if (tail === 'documents')
    return method === 'POST' && typeof body.dotId === 'string';
  if (tail === 'files') return method === 'GET';
  if (tail === 'files/uploads')
    return method === 'POST' && typeof body.dotId === 'string';
  const upload = tail.match(/^files\/uploads\/([^/]+)\/(chunks|complete)$/);
  if (upload) {
    const item = ws.files.upload(spaceId, decodeURIComponent(upload[1]));
    if (item.threadId) ws.requireThread(item.threadId, item.dotId);
    return method === 'POST' && ws.canAccessSpace(item.dotId, spaceId);
  }
  const file = tail.match(
    /^files\/([^/]+)\/(download|preview(?:\/\d+)?|refresh)$/,
  );
  if (file) {
    const item = ws.files.get(spaceId, decodeURIComponent(file[1]));
    return (
      ['GET', 'POST'].includes(method) && ws.canAccessSpace(item.dotId, spaceId)
    );
  }
  return false;
}
