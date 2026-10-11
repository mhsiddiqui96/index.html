'use strict';
// Server-Sent Events hub: pushes live inbox updates to every logged-in admin of a workspace.
const clients = new Map(); // workspaceId -> Set<{res, user}>

function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const wsId = req.user.workspace_id;
  if (!clients.has(wsId)) clients.set(wsId, new Set());
  const client = { res, user: req.user };
  clients.get(wsId).add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.get(wsId)?.delete(client);
  });
}

// `canSee(user)` optionally limits delivery (e.g. agents only see their own/unassigned chats).
function publish(workspaceId, event, data, canSee) {
  const set = clients.get(workspaceId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of set) {
    if (!canSee || canSee(client.user)) client.res.write(frame);
  }
}

module.exports = { subscribe, publish };
