import pytest

from frame_worker.config import Config
from frame_worker.lifecycle import Lifecycle, Busy


class TV:
    def __init__(self):
        self.state = "art"
        self.current_id = "personal"
        self.images = {"personal", "art-store"}
        self.calls = []
        self.fail_upload = False
        self.fail_selection = False
        self.lose_selection_ack = False
        self.fail_delete = False
        self.change_during_upload = False
        self.counter = 0

    def status(self):
        return self.state

    def current(self):
        return self.current_id

    def available(self):
        return set(self.images)

    def upload(self, file):
        self.calls.append("upload")
        self.counter += 1
        content_id = f"service-{self.counter}"
        self.images.add(content_id)
        if self.fail_upload:
            raise TimeoutError("Lost upload acknowledgment")
        if self.change_during_upload:
            self.state = "viewing"
        return content_id

    def select(self, content_id):
        self.calls.append(("select", content_id))
        if self.fail_selection:
            raise TimeoutError("Select failed")
        self.current_id = content_id
        if self.lose_selection_ack:
            raise TimeoutError("Selection completed but acknowledgment lost")

    def delete(self, ids):
        self.calls.append(("delete", list(ids)))
        if self.fail_delete:
            raise TimeoutError("Delete failed")
        self.images.difference_update(ids)


def make(tmp_path):
    tv = TV()
    clock = [1000]
    journal = Lifecycle(tmp_path, tv, "test-tv", 300, lambda: clock[0])
    return journal, tv, clock


def test_activation_replacement_and_minimum_interval_preserve_unrelated_images(tmp_path):
    journal, tv, clock = make(tmp_path)
    assert journal.publish("candidate.jpg", "a") == "awaiting_activation"
    assert not tv.calls
    assert journal.publish("candidate.jpg", "a", activate=True) == "selected"
    assert journal.publish("candidate.jpg", "a") == "unchanged"
    assert journal.publish("next.jpg", "b") == "throttled"
    clock[0] += 300
    assert journal.publish("next.jpg", "b") == "selected"
    assert tv.images == {"personal", "art-store", "service-2"}
    assert tv.calls.index(("select", "service-2")) < tv.calls.index(("delete", ["service-1"]))
    journal.close()


@pytest.mark.parametrize("state", ["sleep", "off", "viewing", "unknown", "unpaired"])
def test_ineligible_states_do_not_mutate_or_wake_tv(tmp_path, state):
    journal, tv, _ = make(tmp_path)
    tv.state = state
    assert journal.publish("candidate.jpg", "a", activate=True) == "deferred_tv_state"
    assert tv.calls == []
    journal.close()


def test_switch_to_viewing_during_upload_never_selects(tmp_path):
    journal, tv, _ = make(tmp_path)
    tv.change_during_upload = True
    assert journal.publish("candidate.jpg", "a", activate=True) == "deferred_before_selection"
    assert tv.calls == ["upload"]
    assert tv.current_id == "personal"
    assert journal.get("pending")["id"] == "service-1"
    journal.close()


def test_failed_selection_reuses_known_upload_after_restart(tmp_path):
    journal, tv, clock = make(tmp_path)
    tv.fail_selection = True
    with pytest.raises(TimeoutError):
        journal.publish("candidate.jpg", "a", activate=True)
    journal.close()
    tv.fail_selection = False
    restarted = Lifecycle(tmp_path, tv, "test-tv", 300, lambda: clock[0])
    assert restarted.publish("candidate.jpg", "a", activate=True) == "selected"
    assert tv.calls.count("upload") == 1
    assert "personal" in tv.images
    restarted.close()


def test_lost_upload_ack_requires_positive_reconciliation_not_automatic_retry(tmp_path):
    journal, tv, clock = make(tmp_path)
    tv.fail_upload = True
    with pytest.raises(TimeoutError):
        journal.publish("candidate.jpg", "a", activate=True)
    journal.close()
    restarted = Lifecycle(tmp_path, tv, "test-tv", 300, lambda: clock[0])
    assert restarted.publish("candidate.jpg", "a", activate=True) == "recovery_required"
    assert tv.calls.count("upload") == 1
    assert "service-1" not in restarted.owned()
    assert restarted.cleanup(True) == []
    with pytest.raises(ValueError):
        restarted.recover_upload("personal", False)
    restarted.recover_upload("service-1", True)
    assert restarted.publish("candidate.jpg", "a", activate=True) == "selected"
    restarted.close()


def test_crash_after_select_is_reconciled_and_cleanup_retried(tmp_path):
    journal, tv, clock = make(tmp_path)
    journal.publish("candidate.jpg", "a", activate=True)
    clock[0] += 300
    tv.fail_delete = True
    with pytest.raises(TimeoutError):
        journal.publish("next.jpg", "b")
    assert tv.current_id == "service-2"
    assert "service-1" in tv.images
    journal.close()
    restarted = Lifecycle(tmp_path, tv, "test-tv", 300, lambda: clock[0])
    assert restarted.cleanup(True) == ["service-1"]
    assert "service-1" in tv.images
    tv.fail_delete = False
    assert restarted.publish("next.jpg", "b") == "unchanged"
    assert tv.images == {"personal", "art-store", "service-2"}
    restarted.close()


def test_single_writer_and_tv_identity_guard(tmp_path):
    journal, tv, _ = make(tmp_path)
    another = Lifecycle(tmp_path, tv, "test-tv")
    with journal.lock(), pytest.raises(Busy):
        another.publish("candidate.jpg", "a")
    with pytest.raises(ValueError):
        Lifecycle(tmp_path, tv, "another-tv")
    another.close()
    journal.close()


def test_lost_selection_ack_is_confirmed_on_restart_without_reupload(tmp_path):
    journal, tv, clock = make(tmp_path)
    tv.lose_selection_ack = True
    with pytest.raises(TimeoutError):
        journal.publish("candidate.jpg", "a", activate=True)
    assert tv.current_id == "service-1"
    assert journal.get("pending")["stage"] == "uploaded"
    journal.close()
    restarted = Lifecycle(tmp_path, tv, "test-tv", 300, lambda: clock[0])
    assert restarted.publish("candidate.jpg", "a") == "unchanged"
    assert restarted.get("pending") is None
    assert restarted.get("selected") == "service-1"
    assert tv.calls.count("upload") == 1
    restarted.close()


def test_worker_configuration_rejects_credential_urls_and_unsafe_flags():
    with pytest.raises(ValueError):
        Config.load({"DEMO_MODE": "true", "DASHBOARD_BACKEND_URL": "https://secret@host"})
    with pytest.raises(ValueError):
        Config.load({"DEMO_MODE": "true", "TV_SAFE_PROBES_CONFIRMED": "yes"})
    with pytest.raises(ValueError):
        Config.load({"DEMO_MODE": "true", "ART_MIN_UPLOAD_INTERVAL_SECONDS": "0"})
