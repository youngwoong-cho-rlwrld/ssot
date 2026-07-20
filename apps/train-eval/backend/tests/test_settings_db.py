from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import (
    cluster_settings,
    clusters,
    notifications_config,
    settings_db,
    user_config,
    user_context,
    wandb_config,
)


class SettingsDbTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.env = patch.dict(os.environ, {"SSOT_DATA_DIR": self.tempdir.name})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.db = Path(self.tempdir.name) / "ssot.db"
        with sqlite3.connect(self.db) as connection:
            connection.executescript(
                """
                CREATE TABLE users (
                  id INTEGER PRIMARY KEY,
                  email TEXT UNIQUE NOT NULL
                );
                CREATE TABLE user_settings (
                  user_id INTEGER NOT NULL,
                  namespace TEXT NOT NULL,
                  key TEXT NOT NULL,
                  value TEXT,
                  updated_at TEXT,
                  PRIMARY KEY (user_id, namespace, key)
                );
                INSERT INTO users (id, email) VALUES
                  (1, 'youngwoong.cho@rlwrld.ai'),
                  (2, 'other@example.com');
                """
            )
        self.token = None

    def tearDown(self) -> None:
        if self.token is not None:
            user_context._current_email.reset(self.token)

    def use_user(self, email: str | None) -> None:
        if self.token is not None:
            user_context._current_email.reset(self.token)
        self.token = user_context._current_email.set(email)

    def seed(self, user_id: int, namespace: str, **values) -> None:
        with sqlite3.connect(self.db) as connection:
            connection.executemany(
                """
                INSERT INTO user_settings (user_id, namespace, key, value, updated_at)
                VALUES (?, ?, ?, ?, 'now')
                """,
                [
                    (user_id, namespace, key, json.dumps(value))
                    for key, value in values.items()
                ],
            )

    def test_every_user_starts_empty_including_former_owner(self) -> None:
        for email in ("youngwoong.cho@rlwrld.ai", "other@example.com", None):
            with self.subTest(email=email):
                self.use_user(email)
                self.assertEqual(settings_db.get_namespace("train-eval"), {})
                self.assertEqual(user_config.get_username(), "")
                self.assertEqual(wandb_config.get_project(), "")
                self.assertEqual(cluster_settings.list_cluster_names(), [])
                self.assertFalse(notifications_config.get_settings().enabled)

    def test_exact_email_rows_are_isolated_without_owner_exception(self) -> None:
        self.seed(1, "profile", username="owner-db")
        self.seed(2, "profile", username="other-db")
        self.seed(1, "train-eval", wandb={"project": "owner", "api_key": "one"})
        self.seed(2, "train-eval", wandb={"project": "other", "api_key": "two"})

        self.use_user("youngwoong.cho@rlwrld.ai")
        self.assertEqual(user_config.get_username(), "owner-db")
        self.assertEqual(wandb_config.get_project(), "owner")
        self.assertEqual(wandb_config.get_api_key(), "one")

        self.use_user("other@example.com")
        self.assertEqual(user_config.get_username(), "other-db")
        self.assertEqual(wandb_config.get_project(), "other")
        self.assertEqual(wandb_config.get_api_key(), "two")

        self.use_user(None)
        self.assertEqual(user_config.get_username(), "")
        self.assertEqual(wandb_config.get_api_key(), "")

    def test_cluster_runtime_reads_only_the_current_sqlite_row(self) -> None:
        owner_text = (
            "SSH_ALIAS=owner-host\nPARTITION=owner\n"
            "LOG_DIR=/owner/logs\nDATA_DIR=/owner/data\n"
        )
        other_text = (
            "SSH_ALIAS=other-host\nPARTITION=other\n"
            "LOG_DIR=/other/logs\nDATA_DIR=/other/data\n"
        )
        self.seed(1, "train-eval", clusters=[{"name": "kakao", "env_text": owner_text}])
        self.seed(2, "train-eval", clusters=[{"name": "kakao", "env_text": other_text}])

        self.use_user("other@example.com")
        env = asyncio.run(clusters.load_cluster("kakao"))
        self.assertEqual(env.ssh_alias, "other-host")
        self.assertEqual(env.vars["DATA_DIR"], "/other/data")

        self.use_user(None)
        self.assertEqual(cluster_settings.list_cluster_names(), [])
        with self.assertRaises(FileNotFoundError):
            asyncio.run(clusters.load_cluster("kakao"))

    def test_compatibility_writes_update_the_same_database(self) -> None:
        self.use_user("other@example.com")
        user_config.save_settings(user_config.UserSettings(username="person"))
        wandb_config.set_project("project")
        wandb_config.set_api_key("secret")
        cluster_settings.save_settings(
            "kakao",
            "SSH_ALIAS=host\nPARTITION=gpu\nLOG_DIR=/logs\nDATA_DIR=/data\n",
        )
        notifications_config.save_settings(
            notifications_config.NotificationSettingsUpdate(
                enabled=True,
                slack_webhook_url="https://hooks.example/secret",
                notify_failed=True,
            )
        )

        self.assertEqual(user_config.get_username(), "person")
        self.assertEqual(wandb_config.get_project(), "project")
        self.assertEqual(wandb_config.get_api_key(), "secret")
        self.assertEqual(cluster_settings.list_cluster_names(), ["kakao"])
        self.assertTrue(notifications_config.get_settings().configured)

        stored = settings_db.get_namespace("train-eval")
        self.assertEqual(stored["wandb"]["api_key"], "secret")
        self.assertEqual(
            stored["notifications"]["slack_webhook_url"],
            "https://hooks.example/secret",
        )

    def test_cluster_write_canonicalizes_command_syntax_as_literal_data(self) -> None:
        self.use_user("other@example.com")
        cluster_settings.save_settings(
            "safe", "SSH_ALIAS=$(touch /tmp/never-run)\nPARTITION=gpu\n"
        )
        text = cluster_settings.load_env_text("safe")
        self.assertIn("'$(touch /tmp/never-run)'", text)
        parsed = cluster_settings.parse_env_text(text, validate_keys=True)
        self.assertEqual(parsed["SSH_ALIAS"], "$(touch /tmp/never-run)")

if __name__ == "__main__":
    unittest.main()
