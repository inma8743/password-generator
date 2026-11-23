(() => {
  'use strict';

  const SOURCE_SIZE = 7776;
  const POOL_SIZE = 7772;
  const MIN_WORDS = 6;
  const MAX_WORDS = 10;
  const RANDOM_SPACE = 0x100000000;
  const DIGIT_CHOICES = 100;
  const EXPECTED_SHA256 = 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e';
  const SEPARATORS = new Set(['-', '.', '_', ' ']);

  async function validateWordList(bytes, cryptoApi) {
    if (bytes.byteLength !== 108800) throw new Error('Wrong list size');
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== EXPECTED_SHA256) throw new Error('Wrong list digest');

    const rows = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split(/\r?\n/);
    const keys = new Set();
    const words = new Set();
    if (rows.length !== SOURCE_SIZE) throw new Error('Wrong word count');
    for (const row of rows) {
      const match = /^([1-6]{5})\t([a-z]+(?:-[a-z]+)?)$/.exec(row);
      if (!match || keys.has(match[1]) || words.has(match[2])) throw new Error('Malformed list');
      keys.add(match[1]);
      words.add(match[2]);
    }
    const pool = [...words].filter(word => !word.includes('-'));
    if (pool.length !== POOL_SIZE) throw new Error('Wrong usable word count');
    return Object.freeze(pool);
  }

  function randomIndex(max, cryptoApi) {
    if (!Number.isSafeInteger(max) || max < 1 || max > RANDOM_SPACE) throw new Error('Invalid range');
    const buffer = new Uint32Array(1);
    const limit = RANDOM_SPACE - RANDOM_SPACE % max;
    for (let attempt = 0; attempt < 128; attempt += 1) {
      cryptoApi.getRandomValues(buffer);
      if (buffer[0] < limit) return buffer[0] % max;
    }
    throw new Error('Secure random selection failed');
  }

  function generate(words, options, cryptoApi) {
    const { count, separator, includeNumber, capitalize } = options;
    if (words.length !== POOL_SIZE || !Number.isInteger(count) || count < MIN_WORDS ||
        count > MAX_WORDS || !SEPARATORS.has(separator)) throw new Error('Invalid settings');

    // Independent uniform draws, with replacement. A repeated word is valid.
    const result = [];
    for (let i = 0; i < count; i += 1) {
      const word = words[randomIndex(words.length, cryptoApi)];
      result.push(capitalize ? word[0].toUpperCase() + word.slice(1) : word);
    }
    if (includeNumber) result.push(String(randomIndex(DIGIT_CHOICES, cryptoApi)).padStart(2, '0'));
    return result.join(separator);
  }

  function entropyBits(count, includeNumber) {
    return count * Math.log2(POOL_SIZE) + (includeNumber ? Math.log2(DIGIT_CHOICES) : 0);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validateWordList, randomIndex, generate, entropyBits, POOL_SIZE };
    return;
  }

  const copy = document.documentElement.lang === 'ko' ? {
    loading: '단어 목록을 확인 중입니다.',
    ready: '버튼을 눌러 패스프레이즈를 생성하세요.',
    failure: '안전한 생성 기능을 시작할 수 없습니다. 최신 브라우저에서 HTTPS 주소로 다시 여세요.',
    generated: '결과를 생성했습니다.',
    copied: '클립보드에 복사했습니다. 다른 곳에 붙여넣거나 공유하지 않도록 주의하세요.',
    copyFailed: '복사하지 못했습니다. 필요한 경우 결과에서 직접 선택해 복사하세요.',
    bits: bits => `현재 설정의 무작위성: 약 ${bits}비트. 대문자와 구분자 선택은 무작위성을 더하지 않습니다.`,
  } : {
    loading: 'Checking the word list.',
    ready: 'Click Generate to create a passphrase.',
    failure: 'Secure generation is unavailable. Reload over HTTPS in a current browser.',
    generated: 'Passphrase generated.',
    copied: 'Copied to your clipboard. Be careful where you paste it; do not share it.',
    copyFailed: 'Copy failed. If needed, select and copy the result manually.',
    bits: bits => `Estimated randomness at these settings: ${bits} bits. Capitalization and separator choices add none.`,
  };
  const $ = id => document.getElementById(id);
  const count = $('word-count');
  const countValue = $('word-count-value');
  const separator = $('separator');
  const includeNumber = $('include-number');
  const capitalize = $('capitalize');
  const output = $('passphrase');
  const hint = $('hint');
  const status = $('passphrase-status');
  const make = $('generate');
  const refresh = $('refresh');
  const copyButton = $('copy');
  let words;
  let current = null;
  let permanentlyFailed = false;

  function showHint() {
    hint.textContent = copy.bits(entropyBits(Number(count.value), includeNumber.checked).toFixed(1));
  }

  function clear() {
    current = null;
    output.textContent = permanentlyFailed ? copy.failure : (words ? copy.ready : copy.loading);
    copyButton.disabled = true;
    status.textContent = '';
  }

  function fail() {
    permanentlyFailed = true;
    words = undefined;
    make.disabled = refresh.disabled = true;
    clear();
  }

  function makeValue() {
    clear();
    if (!words) return;
    try {
      current = generate(words, {
        count: Number(count.value), separator: separator.value,
        includeNumber: includeNumber.checked, capitalize: capitalize.checked
      }, window.crypto);
      output.textContent = current;
      status.textContent = copy.generated;
      copyButton.disabled = false;
    } catch {
      fail();
    }
  }

  function resetOptions() {
    countValue.textContent = count.value;
    showHint();
    clear();
  }

  count.addEventListener('input', resetOptions);
  [separator, includeNumber, capitalize].forEach(field => field.addEventListener('change', resetOptions));
  make.addEventListener('click', makeValue);
  refresh.addEventListener('click', makeValue);
  window.addEventListener('pagehide', clear);
  copyButton.addEventListener('click', async () => {
    if (current === null) return;
    const copiedValue = current;
    try {
      await navigator.clipboard.writeText(copiedValue);
      if (current === copiedValue) status.textContent = copy.copied;
    } catch {
      if (current === copiedValue) status.textContent = copy.copyFailed;
    }
  });

  resetOptions();
  (async () => {
    if (!window.isSecureContext || !window.crypto?.getRandomValues || !window.crypto?.subtle) throw new Error('No Web Crypto');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/assets/eff-large-wordlist.txt', {
        credentials: 'omit', mode: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Word list unavailable');
      words = await validateWordList(await response.arrayBuffer(), window.crypto);
    } finally {
      clearTimeout(timer);
    }
    make.disabled = refresh.disabled = false;
    clear();
  })().catch(fail);
})();
