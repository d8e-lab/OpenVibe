node -e "
const rawCRLF = 'line1\\r\
line2\\r\
line3';
const rawLF = 'line1\
line2\
line3';

// 当前实现（有问题）
function splitLinesCurrent(raw, decode = true) {
  let t = raw;
  if (decode) t = t.replace(/\\\\\\\\n/g, '\
');
  t = t.replace(/\\r\\n/g, '\
').replace(/\\r/g, '\
');
  if (t === '') return [];
  return t.split('\
');
}

// 修复后实现
function splitLinesFixed(raw, decode = true) {
  let t = raw;
  if (decode) {
    t = t.replace(/\\\\\\\\n/g, '\
');
    t = t.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\
');
  }
  if (t === '') return [];
  if (!decode) return t.split(/\\r\\n|\\r|\n/);
  return t.split('\
');
}

console.log('Test 1 - CRLF content with decode=true:');
console.log('Current:', splitLinesCurrent(rawCRLF, true));
console.log('Fixed:  ', splitLinesFixed(rawCRLF, true));

console.log('\
Test 2 - CRLF content with decode=false (MM_OUTPUT mode):');
console.log('Current:', splitLinesCurrent(rawCRLF, false));
console.log('Fixed:  ', splitLinesFixed(rawCRLF, false));
"