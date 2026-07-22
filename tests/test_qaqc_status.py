from qaqc_web import _queue_status


def test_qaqc_queue_status_priority() -> None:
    assert _queue_status(0, set()) == "flag_no_cc"
    assert _queue_status(0, {"reviewed"}) == "flag_no_cc"
    assert _queue_status(2, {"unreviewed"}) == "waiting_for_qc"
    assert _queue_status(2, set()) == "waiting_for_qc"
    assert _queue_status(2, {"edited"}) == "edited"
    assert _queue_status(2, {"added"}) == "edited"
    assert _queue_status(2, {"reviewed"}) == "reviewed"
