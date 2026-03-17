#!/usr/bin/env python3
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

OPENCLAW_CONFIG = Path('/home/node/.openclaw/openclaw.json')
WORKSPACE = Path('/home/node/.openclaw/workspace')
QUOTES_PATH = WORKSPACE / 'finance_system' / 'qq_chat_quotes.txt'
STATE_PATH = WORKSPACE / 'finance_system' / 'qq_style_autolearn_state.json'
SAMPLES_PATH = WORKSPACE / 'finance_system' / 'qq_style_recent_samples.json'
EXCLUDED_USER_IDS = {1010679324}
TARGET_GROUPS = [1061966199, 1016414937]
MAX_MSGS_PER_GROUP = 160
MAX_STORED_MESSAGES = 250
MAX_SAMPLES_FOR_LLM = 80
DEFAULT_MODEL = 'gpt-5.4'
DEFAULT_BASE_URL = 'https://gmn.chuangzuoli.com/v1'
UA = 'curl/8.6.0'

CQ_RE = re.compile(r'\[CQ:[^\]]+\]')
URL_RE = re.compile(r'https?://\S+', re.I)

PROMPT_START = 'QQ group chat only. Speak as Grantly from Knight Academy.'
STYLE_MARKER_START = 'Style flavor examples:'
STYLE_MARKER_END = 'For current web facts, prefer running /home/node/.openclaw/workspace/finance_system/qq_openwebsearch.sh via exec first, then summarize results plainly with sources when useful.'


NODE_HELPER = r"""
const fs = require('fs');

async function onebotCall(wsUrl, token, action, params, echo) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`timeout waiting for ${action}`));
    }, 15000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ action, params, echo }));
    });
    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data || ''));
        if (data.echo === echo) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(data);
        }
      } catch (err) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      }
    });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(event.error || new Error('websocket error'));
    });
    ws.addEventListener('close', () => {});
  });
}

async function main() {
  const mode = process.argv[1];
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (mode === 'history') {
    const result = await onebotCall(payload.ws_url, payload.token, 'get_group_msg_history', { group_id: payload.group_id }, payload.echo);
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (mode === 'responses') {
    const res = await fetch(`${payload.base_url}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${payload.api_key}`,
        'Content-Type': 'application/json',
        'User-Agent': payload.ua,
      },
      body: JSON.stringify(payload.body),
    });
    const text = await res.text();
    process.stdout.write(JSON.stringify({ ok: res.ok, status: res.status, text }));
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
"""


def load_cfg() -> dict[str, Any]:
    return json.loads(OPENCLAW_CONFIG.read_text(encoding='utf-8'))


def save_cfg(cfg: dict[str, Any]) -> None:
    OPENCLAW_CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def resolve_responses_settings(cfg: dict[str, Any]) -> tuple[str, str, str]:
    env_base_url = os.getenv('FINANCE_LLM_BASE_URL', '').strip()
    env_api_key = os.getenv('FINANCE_LLM_API_KEY', '').strip()
    env_model = os.getenv('FINANCE_LLM_MODEL', '').strip()
    if env_base_url and env_api_key:
        return env_base_url.rstrip('/'), env_api_key, env_model or DEFAULT_MODEL

    provider = (((cfg.get('models') or {}).get('providers') or {}).get('codex') or {}) if isinstance(cfg, dict) else {}
    base_url = str(provider.get('baseUrl') or env_base_url or DEFAULT_BASE_URL).strip().rstrip('/')
    api_key = str(provider.get('apiKey') or env_api_key or '').strip()
    model = env_model or DEFAULT_MODEL
    if not api_key:
        raise RuntimeError('finance style learner api key missing; set FINANCE_LLM_API_KEY or configure models.providers.codex.apiKey')
    return base_url, api_key, model


def clean_text(raw: str) -> str:
    text = CQ_RE.sub(' ', str(raw or ''))
    text = URL_RE.sub(' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def is_human_like_line(text: str) -> bool:
    if not text or len(text) < 3 or len(text) > 80:
        return False
    if '【' in text and '】' in text and len(text) > 20:
        return False
    if 'http' in text.lower():
        return False
    return True


def run_node(mode: str, payload: dict[str, Any]) -> Any:
    result = subprocess.run(
        ['node', '-e', NODE_HELPER, mode],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        check=True,
        timeout=240,
    )
    return json.loads((result.stdout or '').strip() or '{}')


def fetch_recent_samples() -> list[dict[str, Any]]:
    cfg = load_cfg()
    qq = cfg['channels']['qq']
    ws_url = qq['wsUrl']
    token = qq.get('accessToken') or ''
    rows: list[dict[str, Any]] = []
    for gid in TARGET_GROUPS:
        ret = run_node('history', {'ws_url': ws_url, 'token': token, 'group_id': gid, 'echo': f'h{gid}'})
        msgs = ((ret.get('data') or {}).get('messages') or [])
        msgs = sorted(msgs, key=lambda x: int(x.get('message_id') or 0))[-MAX_MSGS_PER_GROUP:]
        for m in msgs:
            uid = int(m.get('user_id') or 0)
            if uid in EXCLUDED_USER_IDS:
                continue
            sender = (m.get('sender') or {}).get('card') or (m.get('sender') or {}).get('nickname') or str(uid)
            text = clean_text(str(m.get('raw_message') or ''))
            if not is_human_like_line(text):
                continue
            rows.append({'group_id': gid, 'user_id': uid, 'sender': sender, 'text': text})
    dedup = []
    seen = set()
    for row in rows:
        key = (row['group_id'], row['user_id'], row['text'])
        if key in seen:
            continue
        seen.add(key)
        dedup.append(row)
    dedup = dedup[-MAX_STORED_MESSAGES:]
    return dedup[-MAX_SAMPLES_FOR_LLM:]


def summarize_with_llm(samples: list[dict[str, Any]]) -> dict[str, Any]:
    cfg = load_cfg()
    base_url, api_key, model = resolve_responses_settings(cfg)
    text_blob = '\n'.join(f"[{r['group_id']}] {r['sender']}: {r['text']}" for r in samples)
    prompt = (
        '你在分析两个QQ学习/闲聊群的真人聊天风格。\n'
        '要求：只总结语言风格，不要复述隐私，不要写成长文。\n'
        '请输出严格JSON，格式如下：\n'
        '{"style_summary":"...","quotes":["..."],"dos":["..."],"donts":["..."]}\n'
        '约束：\n'
        '1. quotes 给出 12-20 条适合机器人学习的短句风格样本，必须像真人群聊，不能像公告，不能太长。\n'
        '2. dos 给出 5-8 条应该遵循的说话规则。\n'
        '3. donts 给出 5-8 条应该避免的说话习惯。\n'
        '4. 风格重点：短句、直给、轻吐槽、少客套、别客服、别教师爷。\n'
        '5. 不要输出 markdown，不要加解释。\n\n'
        '样本：\n' + text_blob
    )
    body = {
        'model': model,
        'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}]}],
        'reasoning': {'effort': 'none'},
    }
    resp = run_node('responses', {'base_url': base_url, 'api_key': api_key, 'ua': UA, 'body': body})
    if not resp.get('ok'):
        raise RuntimeError(f"responses api failed: {resp.get('status')} {resp.get('text')}")
    data = json.loads(resp.get('text') or '{}')
    out = []
    for item in data.get('output', []):
        for c in item.get('content', []):
            if c.get('type') == 'output_text':
                t = (c.get('text') or '').strip()
                if t:
                    out.append(t)
    raw = '\n'.join(out).strip()
    return json.loads(raw)


def write_quotes(quotes: list[str]) -> None:
    cleaned = []
    seen = set()
    for q in quotes:
        q = re.sub(r'\s+', ' ', str(q or '')).strip()
        if not is_human_like_line(q):
            continue
        if q in seen:
            continue
        seen.add(q)
        cleaned.append(q)
    QUOTES_PATH.write_text('\n'.join(cleaned) + '\n', encoding='utf-8')


def update_system_prompt(style_summary: str, dos: list[str], donts: list[str], quotes: list[str]) -> None:
    cfg = load_cfg()
    qq = cfg['channels']['qq']
    prompt = qq['systemPrompt']
    style_examples = ' '.join(quotes[:6])
    do_text = ' '.join(dos[:6])
    dont_text = ' '.join(donts[:6])
    generated_block = (
        f' Learned human group style summary: {style_summary} '
        f'Do: {do_text}. '
        f"Don't: {dont_text}."
    )
    if STYLE_MARKER_START in prompt and STYLE_MARKER_END in prompt:
        before, rest = prompt.split(STYLE_MARKER_START, 1)
        _, after = rest.split(STYLE_MARKER_END, 1)
        prompt = before + STYLE_MARKER_START + ' ' + style_examples + '. ' + generated_block + ' ' + STYLE_MARKER_END + after
    else:
        prompt += ' ' + generated_block + ' Style flavor examples: ' + style_examples + '. ' + STYLE_MARKER_END
    qq['systemPrompt'] = prompt
    save_cfg(cfg)


def restart_gateway() -> None:
    subprocess.run("pid=$(pgrep -f 'openclaw-gateway|openclaw gateway run' | head -n 1); if [ -n \"$pid\" ]; then kill \"$pid\"; sleep 1; fi; nohup openclaw gateway run >/tmp/openclaw-gateway-manual.log 2>&1 &", shell=True, check=True, executable='/bin/bash')


def running_in_container() -> bool:
    return Path('/.dockerenv').exists()


def validate_config_best_effort() -> dict[str, Any]:
    validate_env = os.environ.copy()
    validate_env['OPENCLAW_HOME'] = '/home/node'
    try:
        result = subprocess.run(
            ['openclaw', 'config', 'validate', '--json'],
            check=True,
            env=validate_env,
            timeout=20,
            capture_output=True,
            text=True,
        )
        payload = json.loads((result.stdout or '{}').strip() or '{}')
        return {'ok': True, 'result': payload}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


def main() -> int:
    samples = fetch_recent_samples()
    samples = samples[-MAX_STORED_MESSAGES:]
    SAMPLES_PATH.write_text(json.dumps(samples, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    result = summarize_with_llm(samples)
    quotes = result.get('quotes') or []
    dos = result.get('dos') or []
    donts = result.get('donts') or []
    style_summary = str(result.get('style_summary') or '').strip()
    write_quotes(quotes)
    state = {
        'ok': True,
        'sample_count': len(samples),
        'unique_human_users': len({int(r.get('user_id') or 0) for r in samples if int(r.get('user_id') or 0)}),
        'target_groups': TARGET_GROUPS,
        'style_summary': style_summary,
        'quotes_count': len(quotes),
        'quotes_preview': quotes[:8],
        'dos': dos[:8],
        'donts': donts[:8],
        'applied_via': str(QUOTES_PATH),
        'config_touch': False,
        'gateway_restart': 'not_needed',
    }
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(state, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
