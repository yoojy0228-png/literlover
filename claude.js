// Claude API 호출 모듈 (SDK 없이 fetch로 직접 호출)
// 설정은 .env 파일에서 읽습니다: ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_EFFORT, CLAUDE_MAX_TOKENS, CLAUDE_FAST_MODEL
// CLAUDE_MODEL은 문제·키워드 만들기처럼 품질이 중요한 일에, CLAUDE_FAST_MODEL은 질문 판정·AI 차례처럼 짧고 자주 하는 일에 씁니다.
// ANTHROPIC_BASE_URL을 지정하면 다른 주소(테스트용 서버 등)로 보낼 수 있습니다.
const apiUrl = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
const API_VERSION = '2026-10-21';
// 안전 필터가 거절하면 서버가 다른 모델로 자동으로 다시 시도하도록 합니다.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

class ClaudeError extends Error {
  constructor(message, { status = 500, retryable = false, code = 'claude_error', upstream = 0 } = {}) {
    super(message);
    this.upstream = upstream; // Anthropic가 돌려준 원래 HTTP 상태 코드
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function config() {
  return {
    key: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: (process.env.CLAUDE_MODEL || '').trim() || 'claude-sonnet-5-5',
    fastModel: (process.env.CLAUDE_FAST_MODEL || '').trim() || 'claude-haiku-5-5', // 기본 모델과 같은 값을 넣으면 끕니다
    effort: (process.env.CLAUDE_EFFORT || '').trim() || 'low',
    maxTokens: Number(process.env.CLAUDE_MAX_TOKENS) || 4096,
  };
}

function isConfigured() {
  return Boolean(config().key);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callOnce({ system, messages, schema, timeoutMs, model }) {
  const c = config();
  if (!c.key) throw new ClaudeError('서버의 .env 파일에 ANTHROPIC_API_KEY가 없습니다.', { status: 503, code: 'no_key' });

  const body = {
    model: model || c.model,
    max_tokens: c.maxTokens,
    system,
    messages,
    output_config: { effort: c.effort, format: { type: 'json_schema', schema } },
    fallbacks: 'default',
  };

  let res;
  try {
    res = await fetch(apiUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': c.key,
        'anthropic-version': API_VERSION,
        'anthropic-beta': FALLBACK_BETA,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ClaudeError('Claude 서버에 연결하지 못했습니다: ' + e.message, { status: 504, retryable: true, code: 'network' });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401) throw new ClaudeError('API 키가 올바르지 않습니다. .env의 ANTHROPIC_API_KEY를 확인하세요.', { status: 502, code: 'bad_key' });
    // 429(요청 과다), 5xx, 529(과부하)는 잠시 후 다시 시도할 수 있습니다.
    const retryable = res.status === 429 || res.status >= 500;
    throw new ClaudeError(`Claude API 오류 ${res.status}: ${msg}`, { status: 502, retryable, code: 'api_error', upstream: res.status });
  }
  if (data.stop_reason === 'refusal') throw new ClaudeError('Claude가 이 요청에 답하지 않았습니다.', { status: 502, code: 'refusal' });
  if (data.stop_reason === 'max_tokens') throw new ClaudeError('Claude의 답이 최대 토큰 수에서 잘렸습니다.', { status: 502, retryable: true, code: 'max_tokens' });

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError('Claude의 답을 읽지 못했습니다.', { status: 502, retryable: true, code: 'bad_json' });
  }
}

async function attempt(args) {
  try {
    return await callOnce(args);
  } catch (e) {
    if (!(e instanceof ClaudeError) || !e.retryable) throw e;
    await sleep(1200);
    return callOnce(args);
  }
}

// 빠른(싼) 모델이 우리 요청 형식을 받아 주지 않으면(400·404) 그 뒤로는 쓰지 않고 기본 모델로 대신합니다.
let fastOff = false;

// JSON 스키마에 맞는 답을 받아 객체로 돌려줍니다. 일시적인 오류는 한 번 더 시도합니다.
// fast: true면 짧고 자주 하는 일에 쓰는 싼 모델(CLAUDE_FAST_MODEL)로 보냅니다.
async function askJSON({ system, messages, schema, timeoutMs = 60000, fast = false }) {
  const c = config();
  if (fast && !fastOff && c.fastModel !== c.model) {
    try {
      return await attempt({ system, messages, schema, timeoutMs, model: c.fastModel });
    } catch (e) {
      if (!(e instanceof ClaudeError) || ![400, 404].includes(e.upstream)) throw e;
      fastOff = true;
      console.warn(`빠른 모델(${c.fastModel})이 요청을 받아 주지 않아 기본 모델(${c.model})로 대신합니다:`, e.message);
    }
  }
  return attempt({ system, messages, schema, timeoutMs });
}

module.exports = { askJSON, isConfigured, config, ClaudeError };
