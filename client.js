import * as Y from 'https://esm.sh/yjs@13';

let ws = null;
let clientId = null;
let currentRoom = null;


let ydoc = new Y.Doc();
let ymap = ydoc.getMap('root');

function showToast(message, type = "info") {
  const id = "t" + Date.now();
  const html = `
    <div id="${id}" class="toast text-bg-${type} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body">${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>
  `;
  document.getElementById("toastArea").insertAdjacentHTML("beforeend", html);
  new bootstrap.Toast(document.getElementById(id), { delay: 2200 }).show();
}

function StringToBinay(u8) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    const slice = u8.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function BinaryToString(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function RefreshUI() {
  const stored = ymap.get('doc') || {};
  const clone = JSON.parse(JSON.stringify(stored));
  document.getElementById("doc").value = JSON.stringify(clone, null, 2);
}

function ChangeApplier() {
  ymap = ydoc.getMap('root');
  ydoc.on('update', (update, origin) => {
    if (origin === 'local' && ws && ws.readyState === WebSocket.OPEN && currentRoom) {
      ws.send(JSON.stringify({ type: 'update_crdt', room: currentRoom, update: StringToBinay(update) }));
    }
    RefreshUI();
  });
}

function UpdateFromServer(base64) {
  Y.applyUpdate(ydoc, BinaryToString(base64), 'remote');
}

function ApplyPatch(patch) {
  if (!patch) return;
  if (patch.full !== undefined) {
    const newDoc = JSON.parse(JSON.stringify(patch.full));
    ydoc.transact(() => { ymap.set('doc', newDoc); }, 'local');
    return;
  }
  const { path, value } = patch;
  const cur = JSON.parse(JSON.stringify(ymap.get('doc') || {}));
  let ref = cur;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (typeof ref[k] !== 'object' || ref[k] === null) ref[k] = {};
    ref = ref[k];
  }
  ref[path[path.length - 1]] = value;
  ydoc.transact(() => { ymap.set('doc', cur); }, 'local');
}

function generatePatch() {
  const pathStr = document.getElementById("pathInput").value.trim();
  const valueStr = document.getElementById("valueInput").value.trim();
  const type = document.getElementById("typeInput").value;
  if (!pathStr) return showToast("Enter JSON path", "warning");
  if (!valueStr) return showToast("Enter value", "warning");
  const path = pathStr.split('.').map(k => isNaN(k) ? k : Number(k));
  let value;
  try {
    if (type === "string") value = valueStr;
    else if (type === "number") value = Number(valueStr);
    else if (type === "boolean") value = (valueStr === "true");
    else if (type === "json") value = JSON.parse(valueStr);
  } catch { return showToast("Invalid JSON object", "danger"); }
  document.getElementById("edit").value = JSON.stringify({ path, value }, null, 2);
  showToast("Patch generated!", "success");
}

window.generatePatch = generatePatch;

function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket("https://collabrativejsoneditor-2.onrender.com");
  ws.onopen = () => showToast("WebSocket connected", "success");
  ws.onclose = () => showToast("WebSocket closed", "warning");
  ws.onerror = () => showToast("WebSocket error", "danger");
  ws.onmessage = ev => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } handleMessage(msg); };
}

function handleMessage(msg) { 
  if (msg.type === 'hello') {
    clientId = msg.clientId;
    document.getElementById("clientId").textContent = clientId;
    return;
  }
  if (msg.type === 'room_created') {
    document.getElementById("roomInput").value = msg.roomId;
    isCreator = true;
    autoJoinAfterOpen(msg.roomId);
    showToast("Room created: " + msg.roomId, "success");
    return;
  }
  if (msg.type === 'full_state_crdt') {
    ydoc = new Y.Doc();
    ChangeApplier();
    UpdateFromServer(msg.update);
    currentRoom = msg.room;
    document.getElementById("connectedRoom").textContent = currentRoom;
    showToast("Joined room (CRDT): " + currentRoom, "success");
    return;
  }
  if (msg.type === 'remote_update_crdt') {
    UpdateFromServer(msg.update);
    showToast("Received update", "primary");
    return;
  }
  if (msg.type === 'error') showToast("Server: " + msg.message, "danger");
}

function waitForOpenThenSend(obj) {
  if (!ws) connectWS();
  const t = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      clearInterval(t);
      ws.send(JSON.stringify(obj));
    }
  }, 30);
}

function autoJoinAfterOpen(roomId) { waitForOpenThenSend({ type: 'join', room: roomId }); }

document.getElementById("createRoom").onclick = () => { connectWS(); waitForOpenThenSend({ type: 'create_room' }); };

document.getElementById("joinRoomBtn").onclick = () => {
  const rid = document.getElementById("roomInput").value.trim();
  if (!rid) return showToast("Enter room ID first", "warning");
  connectWS();
  waitForOpenThenSend({ type: 'join', room: rid });
};

document.getElementById("sendPatch").onclick = () => {
  if (!currentRoom) return showToast("Not in a room", "warning");
  let parsed;
  try { parsed = JSON.parse(document.getElementById("edit").value); }
  catch { return showToast("Invalid JSON", "danger"); }
  ApplyPatch(parsed);
  showToast("Patch applied locally → CRDT → server", "primary");
};

document.getElementById("copyRoom").onclick = async () => {
  const room = document.getElementById("roomInput").value;
  if (!room) return;
  await navigator.clipboard.writeText(room);
  showToast("Room ID copied", "success");
};

document.getElementById("downloadJson").onclick = () => {
  const obj = ymap.get('doc') || {};
  const data = JSON.stringify(obj, null, 2);
  const blob = new Blob([data], { type: "application/json" });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "room_state.json";
  a.click();
  URL.revokeObjectURL(a.href);
};

document.getElementById("deleteKeyBtn").onclick = () => {
  const key = document.getElementById("deleteKeyInput").value.trim();
  if (!key) return showToast("Enter key to delete", "warning");
  const path = key.split('.');
  const cur = JSON.parse(JSON.stringify(ymap.get('doc') || {}));
  let ref = cur;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof ref[path[i]] !== 'object' || ref[path[i]] === null) return showToast("Invalid path", "danger");
    ref = ref[path[i]];
  }
  delete ref[path[path.length - 1]];
  ydoc.transact(() => { ymap.set('doc', cur); }, 'local');
  showToast("Key deleted", "danger");
};

ChangeApplier();
RefreshUI();
connectWS();