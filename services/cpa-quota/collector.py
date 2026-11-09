"""Server-only, fixed-endpoint quota collector. Never serves management responses."""
import datetime
import fcntl
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request


def clean(value):
    value = str(value)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', value): return ''
    if re.search(r'bearer|token|secret|^sk-|^eyJ|^gh[pousr]_', value, re.I): return ''
    return value


def group_name(value):
    text = str(value).lower()
    if 'claude' in text or 'gpt' in text: return 'Claude/GPT'
    if 'gemini' in text: return 'Gemini'
    return 'Models'


def window_label(value):
    text = str(value).lower()
    if 'week' in text: return 'weekly'
    if 'five' in text or text in ['5h', '5 hours']: return '5h'
    if 'daily' in text: return 'daily'
    return 'Limit'


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def reset_ms(value):
    try:
        if number(value): return int(value * 1000) if value > 0 else None
        return int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def parse_codex(body):
    windows = []
    rate = body.get('rate_limit', {})
    for key in ['primary_window', 'secondary_window']:
        w = rate.get(key) or {}
        used, seconds = w.get('used_percent'), w.get('limit_window_seconds')
        if not number(used) or not 0 <= used <= 100 or not number(seconds) or seconds <= 0:
            continue
        label = f'{seconds / 3600:g}h' if seconds < 86400 else f'{seconds / 86400:g}d'
        windows.append({'label': label, 'usedPercent': used, 'windowSeconds': seconds,
                        'resetAt': reset_ms(w.get('reset_at'))})
    return [{'name': 'Codex', 'windows': windows}] if windows else []


def parse_agy(body):
    limits = []
    for group in body.get('groups', []):
        windows = []
        for bucket in group.get('buckets', group.get('limits', [])):
            fraction = bucket.get('remainingFraction', bucket.get('remaining_fraction'))
            if not number(fraction) or not 0 <= fraction <= 1: continue
            label = window_label(bucket.get('displayName', bucket.get('label', bucket.get('window', 'Limit'))))
            duration = bucket.get('windowSeconds', bucket.get('limit_window_seconds'))
            # Unknown duration stays unknown; reset time does not establish duration.
            windows.append({'label': label, 'usedPercent': round((1 - fraction) * 100, 4),
                            'windowSeconds': duration if number(duration) and duration > 0 else None,
                            'resetAt': reset_ms(bucket.get('resetTime', bucket.get('reset_time')))})
        if windows:
            limits.append({'name': group_name(group.get('displayName', group.get('name', 'Models'))), 'windows': windows})
    return limits


def collect(request, previous, now, salt=b"fixture-only"):
    cached = {a['id']: a for a in previous.get('accounts', [])}
    result = []
    files = request('/auth-files').get('files')
    if not isinstance(files, list): raise ValueError('Invalid account inventory')
    for account in files[:100]:
        provider = account.get('provider', account.get('type'))
        if provider not in ['codex', 'antigravity'] or account.get('disabled'): continue
        identity = account.get('id') or account.get('auth_index') or account.get('name')
        if not isinstance(identity, str) or not identity: continue
        opaque = hmac.new(salt, (provider + ':' + identity).encode(), hashlib.sha256).hexdigest()[:24]
        entry = {'id': opaque, 'provider': provider, 'prefix': '', 'observedAt': None,
                 'stale': True, 'error': 'quota_unavailable', 'limits': []}
        if opaque in cached:
            old = cached[opaque]
            entry['prefix'] = clean(old.get('prefix', ''))
            entry['observedAt'] = old.get('observedAt')
            for limit in old.get('limits', []):
                windows = []
                for w in limit.get('windows', []):
                    if not number(w.get('usedPercent')) or not 0 <= w['usedPercent'] <= 100: continue
                    windows.append({'label': window_label(w.get('label')), 'usedPercent': w['usedPercent'],
                        'windowSeconds': w.get('windowSeconds') if number(w.get('windowSeconds')) else None,
                        'resetAt': w.get('resetAt') if number(w.get('resetAt')) else None})
                if windows: entry['limits'].append({'name': 'Codex' if provider == 'codex' else group_name(limit.get('name')), 'windows': windows})
        try:
            prefix = account.get('prefix')
            if not prefix:
                models = request('/auth-files/models?name=' + urllib.parse.quote(account.get('name', ''), safe='')).get('models', [])
                ids = [m.get('id', '') for m in models if isinstance(m, dict)]
                candidates = {s.split('/')[0] for s in ids if '/' in s}
                if len(candidates) == 1: prefix = candidates.pop()
            entry['prefix'] = clean(prefix or '')
            auth_index = account.get('auth_index') or account.get('authIndex')
            if not auth_index: raise ValueError('Missing account index')
            headers = {'Authorization': 'Bearer $TOKEN$', 'Content-Type': 'application/json'}
            if provider == 'codex':
                url = 'https://chatgpt.com/backend-api/wham/usage'
                account_id = (account.get('id_token') or {}).get('chatgpt_account_id')
                if account_id: headers['Chatgpt-Account-Id'] = account_id
                call = {'authIndex': auth_index, 'method': 'GET', 'url': url, 'header': headers}
            else:
                project = account.get('project_id')
                if not project: raise ValueError('Missing project metadata')
                headers['User-Agent'] = 'antigravity/hub/2.23.0 darwin/arm64'
                call = {'authIndex': auth_index, 'method': 'POST',
                        'url': 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
                        'header': headers, 'data': json.dumps({'project': project})}
            response = request('/api-call', call)
            if not 200 <= response.get('status_code', response.get('statusCode', 0)) < 300:
                raise ValueError('Quota request failed')
            body = response.get('body', {})
            if isinstance(body, str): body = json.loads(body)
            limits = parse_codex(body) if provider == 'codex' else parse_agy(body)
            if not limits: raise ValueError('No valid quota windows')
            entry.update(limits=limits, observedAt=now, stale=False, error=None)
        except Exception:
            # Provider errors can contain identifiers or tokens. Never expose them.
            pass
        result.append(entry)
    return {'schema': 'cpa.quota/v1', 'generatedAt': now, 'accounts': result}


def save(path, snapshot):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(snapshot, stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


def main():
    directory = Path(sys.argv[1])
    credentials = Path(sys.argv[2])
    with (directory / 'collector.lock').open('w') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return
        values = dict(line.split('=', 1) for line in credentials.read_text().splitlines() if '=' in line)
        key = values['MANAGEMENT_KEY'].strip()
        opener = urllib.request.build_opener(NoRedirect())
        deadline = time.monotonic() + 100
        def request(path, data=None):
            timeout = min(8, deadline - time.monotonic())
            if timeout <= 0: raise TimeoutError('Refresh deadline')
            req = urllib.request.Request('http://127.0.0.1:8317/v0/management' + path,
                    data=json.dumps(data).encode() if data is not None else None,
                    headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            with opener.open(req, timeout=timeout) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000: raise ValueError('Response too large')
                return json.loads(raw)
        salt_path = directory / 'identity-salt'
        if not salt_path.exists():
            fd = os.open(salt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream: stream.write(os.urandom(32))
        salt = salt_path.read_bytes()
        path = directory / 'snapshot.json'
        previous = json.loads(path.read_text()) if path.exists() else {}
        try: snapshot = collect(request, previous, int(time.time() * 1000), salt)
        except Exception:
            snapshot = {'schema': 'cpa.quota/v1', 'generatedAt': previous.get('generatedAt', 0), 'accounts': []}
            for old in previous.get('accounts', []):
                if not re.fullmatch(r'[a-f0-9]{24}', old.get('id', '')): continue
                if old.get('provider') not in ['codex', 'antigravity']: continue
                snapshot['accounts'].append({'id': old['id'], 'provider': old['provider'],
                    'prefix': clean(old.get('prefix', '')), 'observedAt': None, 'stale': True,
                    'error': 'refresh_failed', 'limits': []})
        if snapshot: save(path, snapshot)
        print('quota snapshot refreshed; accounts:', len(snapshot.get('accounts', [])))


if __name__ == '__main__': main()
