from iso21423.sequence import FileSequenceStore, SequenceCounter

UUID = "11111111-2222-3333-4444-555555555555"


class BrokenStore:
    def load(self, uuid):
        raise OSError("disk gone")

    def save(self, uuid, value):
        raise OSError("disk gone")



def test_counter_monotonic_across_restart(tmp_path):
    store = FileSequenceStore(str(tmp_path))
    first = SequenceCounter.open(UUID, store)
    last = [first.next() for _ in range(3)]
    assert last == [1, 2, 3]

    reopened = SequenceCounter.open(UUID, FileSequenceStore(str(tmp_path)))
    assert reopened.next() > 1000


def test_reserves_new_block_when_exhausted(tmp_path):
    store = FileSequenceStore(str(tmp_path))
    counter = SequenceCounter.open(UUID, store)
    for _ in range(1001):
        counter.next()
    assert store.load(UUID) >= 2001


def test_store_failure_falls_back_to_epoch_ms():
    counter = SequenceCounter.open(UUID, BrokenStore())
    assert counter.next() > 1.7e12


def test_no_store_starts_at_1():
    counter = SequenceCounter.open(UUID, None)
    assert counter.next() == 1
