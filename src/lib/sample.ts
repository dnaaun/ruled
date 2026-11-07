import { addNote, createDeck } from './ops'
import type { Store } from './store'

export function seedSampleDeck(s: Store) {
  const d = createDeck(s, 'Capitals & curiosities')
  s.batch(() => {
    const basic: [string, string][] = [
      ['Capital of **Mongolia**', 'Ulaanbaatar'],
      ['Capital of **Burkina Faso**', 'Ouagadougou'],
      ['Capital of **Bhutan**', 'Thimphu'],
      ['Capital of **Suriname**', 'Paramaribo'],
      ['What does a *philumenist* collect?', 'Matchbox labels'],
      ['How many hearts does an octopus have?', 'Three — two pump blood through the gills, one through the body.'],
    ]
    for (const [front, back] of basic) addNote(s, d.id, 'basic', { front, back }, ['sample'])
    addNote(s, d.id, 'reversed', { front: 'Kazakhstan', back: 'Astana' }, ['sample'])
    addNote(s, d.id, 'cloze', {
      text: 'The Treaty of {{c1::Westphalia}} ended the {{c2::Thirty Years::how many?}} War in {{c3::1648}}.',
      extra: 'Often cited as the origin of the modern state system.',
    }, ['sample'])
    addNote(s, d.id, 'cloze', {
      text: 'Spaced repetition exploits the {{c1::spacing effect}}: reviews spread over time beat cramming.',
      extra: '',
    }, ['sample'])
  })
  return d
}
