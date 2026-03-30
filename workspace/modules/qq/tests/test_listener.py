from __future__ import annotations

import unittest

from workspace.modules.qq.listener import should_handle_at_message


class QQListenerTest(unittest.TestCase):
    def test_rejects_blacklisted_group(self) -> None:
        event = {"group_id": 123, "raw_message": "[CQ:at,qq=1] hi"}
        self.assertFalse(should_handle_at_message(event, blacklist={123}, self_ids={1}))

    def test_accepts_at_message_in_allowed_group(self) -> None:
        event = {"group_id": 456, "raw_message": "[CQ:at,qq=1] hi"}
        self.assertTrue(should_handle_at_message(event, blacklist=set(), self_ids={1}))

    def test_matches_at_with_additional_attributes(self) -> None:
        event = {"group_id": 789, "raw_message": "[CQ:at,qq=1,name=bot] hi"}
        self.assertTrue(should_handle_at_message(event, blacklist=set(), self_ids={1}))

    def test_invalid_group_id_is_treated_as_non_match(self) -> None:
        event = {"group_id": "abc", "raw_message": "[CQ:at,qq=1] hi"}
        self.assertFalse(should_handle_at_message(event, blacklist=set(), self_ids={1}))


if __name__ == "__main__":
    unittest.main()
