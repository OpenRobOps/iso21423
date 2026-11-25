import re

from iso21423.timestamps import now_timestamp


def test_now_timestamp_format():
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", now_timestamp())
