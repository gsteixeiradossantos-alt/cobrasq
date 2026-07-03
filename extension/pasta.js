// extension/pasta.js — escolhe a pasta local (ex.: OneDrive sincronizado) de onde o
// popup lista PDFs para anexar no eproc. O handle da pasta (File System Access API)
// fica guardado em IndexedDB; o Chrome pode pedir reautorização após reiniciar
// (1 clique no popup). Permissão somente-leitura, só desta pasta.

const DB = 'cobrasq-fs', STORE = 'handles';

function abrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function salvarHandle(h) {
  const db = await abrirDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(h, 'pasta');
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

document.getElementById('escolher').onclick = async () => {
  const st = document.getElementById('status');
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    await salvarHandle(handle);
    let nomes = [];
    for await (const [nome, h] of handle.entries()) {
      if (h.kind === 'file' && /\.pdf$/i.test(nome)) nomes.push(nome);
      if (nomes.length >= 8) break;
    }
    st.innerHTML = '<div class="ok">✓ Pasta <b>' + handle.name + '</b> configurada.' +
      (nomes.length ? '<br>PDFs encontrados: <ul><li>' + nomes.map(n => n.replace(/&/g,'&amp;').replace(/</g,'&lt;')).join('</li><li>') + '</li></ul>' : '<br>(nenhum PDF na raiz da pasta ainda)') +
      'Pode fechar esta aba e usar o popup da extensão.</div>';
  } catch (e) {
    if (e && e.name === 'AbortError') return; // usuário cancelou o seletor
    st.innerHTML = '<div class="warn">Não deu: ' + ((e && e.message) || e) + '</div>';
  }
};
