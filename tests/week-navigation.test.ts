import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { WeekView } from '../src/components/WeekView';
import { getReferenceMonday } from '../src/utils/weekNavigation';
import { localDateISO } from '../src/utils/dates';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
for (const [date, monday, label] of [
  ['2026-09-07', '2026-09-07', 'Questa Settimana'],
  ['2026-09-10', '2026-09-07', 'Questa Settimana'],
  ['2026-09-11', '2026-09-07', 'Questa Settimana'],
  ['2026-09-12', '2026-09-14', 'Settimana Entrante'],
  ['2026-09-13', '2026-09-14', 'Settimana Entrante'],
  ['2026-03-29', '2026-03-30', 'Settimana Entrante'],
  ['2026-10-25', '2026-10-26', 'Settimana Entrante'],
]) {
  test(`week navigation ${date}: reference, color, accessibility and return`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(`${date}T12:00:00`).getTime() });
    assert.equal(localDateISO(getReferenceMonday(new Date())), monday);
    let renderer: any;
    await act(async () => { renderer = create(React.createElement(WeekView, {
      timetable: [], events: [], onOpenNewEvent() {}, onEditEvent() {},
    })); });
    const referenceButton = () => renderer.root.findAllByType('button').find((b: any) => b.props['aria-pressed'] !== undefined);
    const checkCurrent = () => {
      assert.equal(referenceButton().props['aria-pressed'], true);
      assert.equal(referenceButton().props.disabled, true);
      assert.match(referenceButton().props.className, /bg-emerald-100/);
      assert.deepEqual(referenceButton().children, [label]);
    };
    checkCurrent();
    for (const direction of ['Settimana precedente', 'Settimana successiva']) {
      const arrow = renderer.root.findByProps({ 'aria-label': direction });
      assert.match(arrow.props.className, /min-w-\[44px\] min-h-\[44px\]/);
      assert.match(arrow.findByType('span').props.className, /w-\[36px\] h-\[36px\]/);
      await act(async () => { arrow.props.onClick(); });
      assert.equal(referenceButton().props['aria-pressed'], false);
      assert.equal(referenceButton().props.disabled, false);
      assert.match(referenceButton().props.className, /bg-amber-50/);
      assert.deepEqual(referenceButton().children, [label]);
      await act(async () => { referenceButton().props.onClick(); });
      checkCurrent();
    }
    await act(async () => { renderer.unmount(); });
  });
}
test('explicit Saturday target can retain the preceding teaching week', () => {
  assert.equal(localDateISO(getReferenceMonday(new Date('2026-09-12T12:00:00'), false)), '2026-09-07');
});
