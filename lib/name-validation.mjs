function canonicalWhitespace(value) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function normalizedName(value) {
  return typeof value === 'string' ? canonicalWhitespace(value).toLowerCase() : '';
}

export function validateDisplayName(value, links = [], currentId = null, reportMonth = undefined) {
  if (typeof value !== 'string') throw Error('Tên hiển thị là bắt buộc.');
  const name = value.normalize('NFC').trim();
  if (!name) throw Error('Tên hiển thị là bắt buộc.');
  if (name.length > 150) throw Error('Tên hiển thị tối đa 150 ký tự.');
  const key = normalizedName(name);
  if (links.some(link => {
    const month = link.reportMonth || link.from?.slice?.(0, 7) || null;
    return link.id !== currentId && normalizedName(link.name) === key && (reportMonth === undefined || month === reportMonth);
  })) throw Error('Tên hiển thị đã tồn tại.');
  return name;
}
