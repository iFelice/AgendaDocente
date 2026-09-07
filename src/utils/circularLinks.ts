import type { CalendarEvent, CircularDocument } from '../types';

/** Only migrate a legacy link when the document and the original item are unambiguous. */
export function linkLegacyCircularEvents(events: CalendarEvent[], circulars: CircularDocument[]): CalendarEvent[] {
  return events.map(event => {
    if (event.sourceType !== 'circolare' || event.sourceCircularId || event.sourceItemId || !event.sourceCircularTitle) return event;
    const docs = circulars.filter(c => c.title === event.sourceCircularTitle);
    if (docs.length !== 1) return event;
    const doc = docs[0];
    const candidates = (doc.extractedItems || []).filter(it => it.title === event.title && it.date === event.date
      && (it.startTime || undefined) === event.startTime && (it.endTime || undefined) === event.endTime
      && (it.className || undefined) === event.className);
    if (candidates.length !== 1) return event;
    const item = candidates[0];
    const matchingEvents = events.filter(e => e.sourceType === 'circolare' && e.sourceCircularTitle === doc.title
      && e.title === event.title && e.date === event.date && e.startTime === event.startTime
      && e.endTime === event.endTime && e.className === event.className);
    if (matchingEvents.length !== 1 || !item.tempId) return event;
    return { ...event, sourceCircularId: doc.id, sourceItemId: item.tempId };
  });
}
