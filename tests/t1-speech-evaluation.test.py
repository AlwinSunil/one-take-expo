import importlib.util
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from evaluate_t1_speech import evaluate


def row(i, **extra):
    return dict(id=str(i), speaker_id='heldout', recording_id=str(i), audio_sha256=str(i),
                split='heldout', source='consented', consented=True, reference='disclosure',
                hypothesis='disclosure', label='clean', expected_flub=False, detected_flub=False,
                device='test device', os='test OS', build='test build', model_config='test config',
                processor='CPU', reviewer='test reviewer', prediction_commit='test commit', **extra)


def dataset():
    tuning = row('tuning')
    tuning.update(split='tuning', speaker_id='tuning')
    return [tuning] + [row(i, must_say=True, evaluation_run='predeclared', read_order=i,
                          must_say_status='covered') for i in range(1, 21)]


class TierOneEvaluation(unittest.TestCase):
    def test_empty_is_not_accuracy(self):
        self.assertFalse(evaluate([])['must_say_passes'])
        self.assertIsNone(evaluate([])['reasons']['agreement'])

    def test_twenty_full_ordered_reads(self):
        self.assertTrue(evaluate(dataset())['must_say_passes'])

    def test_synthetic_never_qualifies(self):
        rows = dataset()
        for r in rows:
            r.update(source='synthetic', consented=False)
        self.assertFalse(evaluate(rows)['must_say_passes'])

    def test_pending_or_false_flag_breaks_entire_run(self):
        for change in ({'must_say_status': 'pending'}, {'detected_flub': True}):
            rows = dataset()
            rows[2].update(change)
            self.assertFalse(evaluate(rows)['must_say_passes'])

    def test_missing_order_duplicate_audio_and_leakage(self):
        for change in ({'read_order': 22}, {'audio_sha256': '1'}, {'speaker_id': 'tuning'}):
            rows = dataset()
            rows[2].update(change)
            self.assertFalse(evaluate(rows)['must_say_passes'])

    def test_reason_threshold_requires_all_detected_flags_reviewed(self):
        rows = dataset()[:1]
        for i in range(10):
            r = row(i, reason_matches=i < 8)
            r.update(label='flub', expected_flub=True, detected_flub=True)
            rows.append(r)
        self.assertTrue(evaluate(rows)['reasons']['passes'])
        del rows[1]['reason_matches']
        self.assertFalse(evaluate(rows)['reasons']['passes'])

    def test_command_false_triggers_measured_separately(self):
        rows = dataset()
        rows[1].update(expected_command=False, detected_command=True)
        rows[2].update(expected_command=True, detected_command=False)
        result = evaluate(rows)['commands']
        self.assertEqual(result['false_trigger_rate'], 1)
        self.assertEqual(result['missed_commands'], 1)

    def test_missing_provenance_and_string_booleans(self):
        rows = dataset()
        del rows[1]['processor']
        self.assertFalse(evaluate(rows)['must_say_passes'])
        rows[1]['reason_matches'] = 'true'
        with self.assertRaises(ValueError):
            evaluate(rows)


if __name__ == '__main__':
    unittest.main()
