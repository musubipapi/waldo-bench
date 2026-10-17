"""A few checks on the parts the numbers depend on. Offline; run with `uv run python -m unittest`."""

import json
import unittest

from waldobench import common, results, search_jev, search_tiles


class Scoring(unittest.TestCase):
    cases = [{"id": f"t{i}", "positive": i == 2} for i in range(4)]

    def rows(self, answers):
        return [{"case_id": f"t{i}", "answer": a} for i, a in enumerate(answers)]

    def test_the_answer_is_the_surest_tile(self):
        result = search_tiles.score_scene(self.cases, self.rows([0.1, 0.3, 0.9, 0.2]), repeat=0)
        self.assertEqual((result["winner"], result["top1_hit"]), ("t2", True))

    def test_ties_are_broken_the_same_way_for_every_model_and_never_by_the_label(self):
        tied = self.rows([0.9, 0.9, 0.9, 0.9])
        winners = {search_tiles.score_scene(self.cases, tied, repeat=0)["winner"] for _ in range(3)}
        flipped = [{**c, "positive": not c["positive"]} for c in self.cases]
        self.assertEqual(len(winners), 1)
        self.assertEqual(search_tiles.score_scene(flipped, tied, repeat=0)["winner"], winners.pop())

    def test_an_unfinished_search_scores_zero_even_on_the_right_tile(self):
        result = search_tiles.score_scene(self.cases, self.rows([0.1, 0.1, 0.9, None]), repeat=0)
        self.assertEqual((result["winner"], result["complete"], result["top1_hit"]), ("t2", False, False))


class Requests(unittest.TestCase):
    def test_tile_request_sends_reference_then_tile_and_no_label(self):
        body = search_tiles.payload("decider", "data:image/jpeg;base64,REF", "data:image/jpeg;base64,TILE")
        self.assertEqual([p["image_url"]["url"] for p in body["state"]], ["data:image/jpeg;base64,REF", "data:image/jpeg;base64,TILE"])
        self.assertEqual(body["questions"]["present"]["type"], "noul")
        self.assertEqual(body["provider"], {"order": ["perplexity"], "allow_fallbacks": False})
        for leak in ("positive", "truth", "box"):
            self.assertNotIn(leak, json.dumps(body))

    def test_jev_request_puts_scene_reference_and_tiles_where_typesafe_documents(self):
        body = search_jev.choice_payload("data:image/jpeg;base64,SCENE", ["data:image/jpeg;base64,A", "data:image/jpeg;base64,B"], "data:image/jpeg;base64,REF")
        question = body["questions"]["tile"]
        self.assertEqual(body["state"]["scene"]["image_url"]["url"], "data:image/jpeg;base64,SCENE")
        self.assertEqual(question["instructions"][1]["image_url"]["url"], "data:image/jpeg;base64,REF")
        self.assertEqual({k: v["image_url"]["url"] for k, v in question["criteria"].items()},
                         {"tile_1": "data:image/jpeg;base64,A", "tile_2": "data:image/jpeg;base64,B"})


class Tiling(unittest.TestCase):
    def test_tiles_cover_the_scene_and_the_last_one_sits_on_the_edge(self):
        self.assertEqual(common.tile_starts(400, 128, 80), [0, 80, 160, 240, 272])
        self.assertTrue(common.overlap([0, 0, 128, 128], [127, 127, 140, 140]))
        self.assertFalse(common.overlap([0, 0, 128, 128], [128, 0, 140, 10]))


class Statistics(unittest.TestCase):
    def test_likely_range_and_head_to_head_are_repeatable(self):
        lead = [{"id": f"1_{i}", "scene_group": f"g{i}", "found": i % 5 != 0} for i in range(1, 41)]
        other = [{**r, "found": i % 2 == 0} for i, r in enumerate(lead)]
        self.assertEqual(results.likely_range(lead), results.likely_range(lead))
        low, high = results.likely_range(lead)
        self.assertLess(low, sum(r["found"] for r in lead) / len(lead))
        self.assertGreater(high, sum(r["found"] for r in lead) / len(lead))
        self.assertGreater(results.head_to_head(lead, other)["gap"], 0)


if __name__ == "__main__":
    unittest.main()
