const {readFileSync} = require('node:fs');
const {webcrypto} = require('node:crypto');
const {join} = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const {validateWordList, randomIndex, generate, entropyBits, POOL_SIZE} = require('../assets/passphrase.js');

const list = readFileSync(join(__dirname,'../assets/eff-large-wordlist.txt'));
const scripted = (...values) => ({
  getRandomValues(buffer) {
    assert.ok(values.length, 'unexpected random draw');
    buffer[0] = values.shift();
    return buffer;
  }
});

test('only the intact, uniquely keyed EFF list is accepted', async () => {
  const words = await validateWordList(list, webcrypto);
  assert.equal(words.length, 7772);
  assert.equal(new Set(words).size, POOL_SIZE);
  assert.ok(words.every(word => /^[a-z]+$/.test(word)));
  await assert.rejects(validateWordList(list.subarray(0,-1), webcrypto));
  const tampered = Buffer.from(list);
  tampered[6] ^= 1;
  await assert.rejects(validateWordList(tampered, webcrypto));
});

test('rejection sampling redraws a value in the biased tail', () => {
  assert.equal(randomIndex(7772, scripted(0xffffffff, 7771)), 7771);
  assert.equal(randomIndex(100, scripted(0xffffffff, 0)), 0);
  assert.throws(() => randomIndex(0, scripted()));
  assert.throws(() => randomIndex(7772, {getRandomValues() { throw new Error(); }}));
  assert.throws(() => randomIndex(7772, {getRandomValues(arr) { arr[0] = 0xffffffff; }}));
});

test('independent synthetic draws allow repeats and the full optional digit range', async () => {
  const words = await validateWordList(list, webcrypto);
  const options = {count: 6, separator: '-', includeNumber: true, capitalize: false};
  const parts = generate(words, options, scripted(0,0,1,2,3,4,0)).split('-');
  assert.equal(parts.length, 7);
  assert.equal(parts[0], parts[1]);
  assert.equal(parts[6], '00');
  const longer = generate(words, {...options,count:10,separator:'.',capitalize:true},
    scripted(0,0,0,0,0,0,0,0,0,0,99)).split('.');
  assert.equal(longer.length, 11);
  assert.equal(longer[10], '99');
  assert.ok(/^[A-Z][a-z]+$/.test(longer[0]));
  assert.throws(() => generate(words, {...options,count:5}, scripted()));
  assert.throws(() => generate(words, {...options,count:11}, scripted()));
  assert.throws(() => generate(words, {...options,separator:''}, scripted()));
});

test('entropy labels agree with the choices actually sampled', () => {
  assert.equal(entropyBits(6,false).toFixed(1),'77.5');
  assert.equal(entropyBits(6,true).toFixed(1),'84.2');
});

test('both pages share the script, disable copy until success, and contain no vendor scripts', () => {
  for (const page of ['passphrase.html','en/passphrase.html']) {
    const html = readFileSync(join(__dirname,'..',page), 'utf8');
    assert.match(html,/min="6" max="10" value="6"/);
    assert.match(html,/<button id="copy"[^>]* disabled>/);
    assert.match(html,/<button id="generate"[^>]* disabled>/);
    assert.deepEqual([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match=>match[1]), ['/assets/passphrase.js']);
    assert.match(html,/Content-Security-Policy/);
    assert.doesNotMatch(html,/G-3EZW95TCSF|adsbygoogle|PartnersCoupang/);
  }
});

const vm = require('node:vm');
const appScript = readFileSync(join(__dirname,'../assets/passphrase.js'),'utf8');
function runPage(lang, {secure = true, response = list, ok = true, failRandom = false} = {}) {
  const ids = new Map();
  let copiedSegments = 0;
  const fetchCalls = [];
  const random = {
    subtle: webcrypto.subtle,
    getRandomValues(array) {
      if (failRandom) throw new Error('Test crypto unavailable');
      array[0] = 0;
      return array;
    }
  };
  function elem(id) {
    const callbacks = new Map();
    if (ids.has(id)) return ids.get(id);
    const n = {
      value: id === 'word-count' ? '6' : id === 'separator' ? '-' : '',
      checked: false, disabled: ['generate','copy','refresh'].includes(id), textContent: '',
      addEventListener(name,fn) { callbacks.set(name,fn); },
      dispatch(name) { return callbacks.get(name)?.(); }
    };
    ids.set(id,n);
    return n;
  }
  const window = elem('window');
  window.isSecureContext = secure;
  window.crypto = random;
  vm.runInNewContext(appScript, {
    window, TextDecoder, AbortController, setTimeout, clearTimeout,
    document:{documentElement:{lang},getElementById:elem},
    navigator:{clipboard:{async writeText(value) { copiedSegments = value.split('-').length; }}},
    async fetch(url, options) {
      fetchCalls.push({url, options});
      return {ok, async arrayBuffer() {return response.buffer.slice(response.byteOffset,response.byteOffset+response.byteLength);}};
    }
  });
  return {elem, window, fetchCalls, getCopiedSegments:()=>copiedSegments};
}
async function until(testCondition) {
  for(let i=0;i<100;i+=1) {
    if(testCondition()) return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('timed out waiting for page state');
}

test('both locales only generate on request, copy current output, and clear on settings/navigation', async () => {
  for (const lang of ['ko','en']) {
    const page = runPage(lang);
    const e = page.elem;
    assert.equal(e('generate').disabled,true);
    await until(()=>!e('generate').disabled);
    assert.equal(e('copy').disabled,true);
    assert.match(e('hint').textContent,/77\.5/);
    assert.equal(page.fetchCalls.length,1);
    assert.equal(page.fetchCalls[0].url,'/assets/eff-large-wordlist.txt');
    assert.equal(page.fetchCalls[0].options.mode,'same-origin');
    assert.equal(page.fetchCalls[0].options.credentials,'omit');
    assert.equal(page.fetchCalls[0].options.redirect,'error');
    e('generate').dispatch('click');
    assert.equal(e('copy').disabled,false);
    assert.equal(e('passphrase').textContent.split('-').length,6);
    await e('copy').dispatch('click');
    assert.equal(page.getCopiedSegments(),6);
    e('include-number').checked = true;
    e('include-number').dispatch('change');
    assert.equal(e('copy').disabled,true);
    assert.match(e('hint').textContent,/84\.2/);
    e('refresh').dispatch('click');
    assert.ok(e('passphrase').textContent.endsWith('-00'));
    page.window.dispatch('pagehide');
    assert.equal(e('copy').disabled,true);
    assert.equal(e('passphrase').textContent.endsWith('-00'),false);
    assert.equal(page.fetchCalls.length,1);
  }
});

test('UI stays closed if the environment or list is unavailable or random draws fail', async () => {
  for(const options of [{secure:false},{response:Buffer.from('corrupt')},{ok:false}]) {
    const page=runPage('en',options), e=page.elem;
    await until(()=>e('passphrase').textContent.includes('unavailable'));
    assert.equal(e('generate').disabled,true);
    assert.equal(e('copy').disabled,true);
    assert.equal(e('refresh').disabled,true);
    if (options.secure===false) assert.equal(page.fetchCalls.length,0);
  }
  const e=runPage('en',{failRandom:true}).elem;
  await until(()=>!e('generate').disabled);
  e('generate').dispatch('click');
  assert.match(e('passphrase').textContent,/unavailable/);
  assert.equal(e('generate').disabled,true);
  assert.equal(e('copy').disabled,true);
});
