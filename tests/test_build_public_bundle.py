import unittest

from scripts.build_public_bundle import PROFILES, _balanced_rows


class PublicBundleTest(unittest.TestCase):
    def test_public_profile_keeps_group_evidence_for_all_evidence_types(self):
        profile = PROFILES["public"]
        self.assertEqual(profile["feature_examples_per_group"], 1)
        self.assertEqual(profile["joint_examples_per_group"], 1)
        self.assertEqual(profile["coactivation_examples_per_group"], 1)

    def test_balanced_rows_keep_each_group_and_sampling_mode(self):
        rows = [
            {"id": 0, "group": "en", "selection_kind": "strongest"},
            {"id": 1, "group": "en", "selection_kind": "strongest"},
            {"id": 2, "group": "de", "selection_kind": "random_present"},
            {"id": 3, "group": "fr", "selection_kind": "near_boundary"},
            {"id": 4, "group": "de", "selection_kind": "strongest"},
        ]

        kept = _balanced_rows(rows, first=1, per_group=1, per_mode=1)
        groups = {row["group"] for row in kept}
        modes = {row["selection_kind"] for row in kept}

        self.assertEqual(groups, {"en", "de", "fr"})
        self.assertEqual(modes, {"strongest", "random_present", "near_boundary"})
        self.assertEqual(len({row["id"] for row in kept}), len(kept))


if __name__ == "__main__":
    unittest.main()
