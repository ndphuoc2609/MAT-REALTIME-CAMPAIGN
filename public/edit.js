const campaignEditor = new MutationObserver(() => {
  document.querySelectorAll('#campaignList .campaign').forEach(card => {
    if (card.querySelector('[data-edit]')) return;
    const source = card.querySelector('[data-sync]'); if (!source) return;
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Sửa'; button.dataset.edit = source.dataset.sync;
    button.onclick = async () => { const state = await (await fetch('/api/state')).json(); const c = state.sourceCampaigns.find(x => x.id === button.dataset.edit); if (!c) return; const label = prompt('Tên hiển thị', c.label); if (label === null) return; const link = prompt('Link báo cáo', c.link); if (link === null) return; await fetch('/api/campaigns/' + c.id, { method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({ label, link }) }); location.reload(); };
    const output = document.createElement('button'); output.className = 'secondary'; output.textContent = 'Nhận CSV vừa crawl'; output.onclick = async () => { output.disabled = true; const r = await fetch('/api/import/output', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({campaignId: source.dataset.sync}) }); const j = await r.json(); output.textContent = r.ok ? `Đã nhận ${j.count} dòng` : 'Lỗi nhận CSV'; if (r.ok) location.reload(); }; source.parentElement.append(' ', button, ' ', output);
  });
});
campaignEditor.observe(document.body, { childList:true, subtree:true });
