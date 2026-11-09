import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('collector.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

class QuotaTests(unittest.TestCase):
    def test_codex_preserves_zero_and_unknown_reset(self):
        limits = collector.parse_codex({'rate_limit': {'primary_window': {
            'used_percent': 0, 'limit_window_seconds': 18000}}})
        self.assertEqual(limits[0]['windows'][0], {
            'label': '5h', 'usedPercent': 0, 'windowSeconds': 18000, 'resetAt': None})
        self.assertEqual(collector.parse_codex({'rate_limit': {'primary_window': {'used_percent': 40}}}), [])

    def test_antigravity_remaining_is_used_without_fake_reset(self):
        limits = collector.parse_agy({'groups': [{'displayName': 'Claude/GPT', 'buckets': [
            {'remainingFraction': .48, 'window': 'weekly'}, {'label': 'unknown'}]}]})
        w = limits[0]['windows'][0]
        self.assertEqual(w['usedPercent'], 52)
        self.assertIsNone(w['resetAt'])
        self.assertEqual(len(limits[0]['windows']), 1)

    def test_collector_sanitizes_and_retains_stale_on_error(self):
        accounts = [{'id': 'private@email', 'name': 'secret.json', 'auth_index': 'index',
                     'provider': 'codex', 'email': 'private@email', 'id_token': {'chatgpt_account_id': 'secret'}}]
        def request(path, data=None):
            if path == '/auth-files': return {'files': accounts}
            if path.startswith('/auth-files/models'): return {'models': [{'id': 'main/gpt-test'}]}
            return {'status_code': 200, 'body': json.dumps({'rate_limit': {'primary_window': {
                'used_percent': 40, 'limit_window_seconds': 18000}}})}
        first = collector.collect(request, {}, 1000000)
        text = json.dumps(first)
        for forbidden in ['private@email', 'secret.json', 'index', 'id_token', 'Bearer']:
            self.assertNotIn(forbidden, text)
        self.assertEqual(first['accounts'][0]['prefix'], 'main')
        def failed(path, data=None):
            if path == '/auth-files': return {'files': accounts}
            raise RuntimeError('secret upstream error')
        second = collector.collect(failed, first, 2000000)
        self.assertTrue(second['accounts'][0]['stale'])
        self.assertEqual(second['accounts'][0]['observedAt'], 1000000)
        self.assertEqual(second['accounts'][0]['limits'], first['accounts'][0]['limits'])
        self.assertNotIn('secret upstream', json.dumps(second))

    def test_presentation_fields_do_not_disclose_identifiers_or_tokens(self):
        accounts = [{'id': 'id', 'name': 'name', 'auth_index': 'idx',
                     'provider': 'antigravity', 'project_id': 'p', 'prefix': 'private@example.com'}]
        def request(path, data=None):
            if path == '/auth-files': return {'files': accounts}
            return {'status_code': 200, 'body': {'groups': [{'displayName': 'Bearer SECRET',
                'buckets': [{'remainingFraction': .5, 'displayName': 'private@example.com'}]}]}}
        text = json.dumps(collector.collect(request, {}, 100, b'salt'))
        for forbidden in ('private@example.com', 'privateexample.com', 'Bearer SECRET'):
            self.assertNotIn(forbidden, text)

    def test_keylike_prefix_and_cached_presentation_are_never_published(self):
        self.assertEqual(collector.clean('sk-example123'), '')
        account = {'id': 'id', 'name': 'name', 'auth_index': 'idx', 'provider': 'codex'}
        def request(path, data=None):
            if path == '/auth-files': return {'files': [account]}
            raise RuntimeError('failed')
        first = collector.collect(request, {}, 100, b'salt')
        cached = first['accounts'][0]
        cached.update(prefix='sk-example123', limits=[{'name': 'Bearer SECRET', 'windows': [
            {'label': 'privateexample.com', 'usedPercent': 50, 'windowSeconds': None, 'resetAt': None}]}])
        text = json.dumps(collector.collect(request, first, 200, b'salt'))
        for forbidden in ['sk-example123', 'Bearer SECRET', 'privateexample.com']:
            self.assertNotIn(forbidden, text)

    def test_atomic_private_snapshot(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'snapshot.json'
            collector.save(p, {'schema': 'cpa.quota/v1', 'accounts': []})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(p.read_text())['accounts'], [])

if __name__ == '__main__': unittest.main()
