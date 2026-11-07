"""Build small Anki packages with real Anki (pip install anki) for tests/anki.test.ts.

    python3 -m venv venv && ./venv/bin/pip install anki
    ./venv/bin/python scripts/make-anki-fixtures.py tests/fixtures

Writes sample.apkg (new zstd format, collection.anki21b), sample-legacy.apkg (collection.anki21)
and sample.colpkg, plus sample.json describing the expected card states.
"""
import json, os, sys, tempfile, time
from anki.collection import Collection, ExportAnkiPackageOptions, ExportLimit

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
tmp = tempfile.mkdtemp()
col = Collection(os.path.join(tmp, 'c.anki2'))

# a 1x1 png in the media folder
png = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000d49444154789c6360f8cf000000020101007c3c4e8d0000000049454e44ae426082')
with open(os.path.join(col.media.dir(), 'dot.png'), 'wb') as f:
    f.write(png)

parent = col.decks.id('Languages')
child = col.decks.id('Languages::French')
geo = col.decks.id('Geography')

# deck options for French
conf = col.decks.add_config_returning_id('French options')
c = col.decks.get_config(conf)
c['new']['perDay'] = 7
c['new']['delays'] = [2, 15, 60]
c['new']['ints'] = [2, 5, 0]
c['new']['initialFactor'] = 2300
c['rev']['perDay'] = 150
c['rev']['ease4'] = 1.4
c['rev']['ivlFct'] = 0.9
c['rev']['hardFactor'] = 1.1
c['rev']['maxIvl'] = 3650
c['lapse']['delays'] = [5, 30]
c['lapse']['mult'] = 0.2
c['lapse']['minInt'] = 2
c['lapse']['leechFails'] = 6
c['lapse']['leechAction'] = 0
col.decks.update_config(c)
d = col.decks.get(child)
d['conf'] = conf
col.decks.save(d)

def add(model, deck, fields, tags=()):
    m = col.models.by_name(model)
    n = col.new_note(m)
    for i, v in enumerate(fields):
        n.fields[i] = v
    n.tags = list(tags)
    col.add_note(n, deck)
    return n

basic = add('Basic', child, ['bonjour', 'hello [sound:hello.mp3]'], ['fr', 'greet::basic'])
rev = add('Basic (and reversed card)', child, ['chat', 'cat <img src="dot.png">'])
opt = add('Basic (optional reversed card)', geo, ['Paris', 'capital of France', ''])
opt2 = add('Basic (optional reversed card)', geo, ['Rome', 'capital of Italy', 'y'])
cloze = add('Cloze', geo, ['{{c1::Canberra}} is the capital of {{c2::Australia::country}}', 'extra info'])
fresh = add('Basic', geo, ['untouched', 'new card'])

sched = col.sched
def answer(cid, rating):
    card = col.get_card(cid)
    card.start_timer()
    sched.answerCard(card, rating)

class R: AGAIN, HARD, GOOD, EASY = 1, 2, 3, 4
cards = {}
for n in (basic, rev, opt, opt2, cloze, fresh):
    for card in n.cards():
        cards[f'{n.fields[0][:12]}#{card.ord}'] = card.id

# bonjour: graduate to review (good, good)
answer(cards['bonjour#0'], R.GOOD); answer(cards['bonjour#0'], R.GOOD)
# chat#0: in learning after one good
answer(cards['chat#0'], R.GOOD)
# Paris: easy -> review, then suspend
answer(cards['Paris#0'], R.EASY)
sched.suspend_cards([cards['Paris#0']])
# Rome#0: review then lapse -> relearning
answer(cards['Rome#0'], R.EASY)
c2 = col.get_card(cards['Rome#0']); c2.due = sched.today; col.update_card(c2)
answer(cards['Rome#0'], R.AGAIN)
# cloze c1: easy, then bury
answer(cards['{{c1::Canber#0'], R.EASY)
sched.bury_cards([cards['{{c1::Canber#0']])

col.save() if hasattr(col, 'save') else None

opts = lambda legacy: ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True, with_media=True, legacy=legacy)
col.export_anki_package(out_path=os.path.join(out, 'sample.apkg'), options=opts(False), limit=None)
col.export_anki_package(out_path=os.path.join(out, 'sample-legacy.apkg'), options=opts(True), limit=None)

expect = {
    'crt': col.crt,
    'today': sched.today,
    'cards': {k: dict(zip(['type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses', 'left', 'odid'],
                           col.db.first('select type, queue, due, ivl, factor, reps, lapses, left, odid from cards where id=?', v)))
              for k, v in cards.items()},
    'revlog': col.db.scalar('select count() from revlog'),
}
col.export_collection_package(os.path.join(out, 'sample.colpkg'), include_media=True, legacy=False)
with open(os.path.join(out, 'sample.json'), 'w') as f:
    json.dump(expect, f, indent=1)
print(json.dumps(expect, indent=1))
