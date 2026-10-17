import { EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent } from 'typeorm';
import { Word } from '../word.entity';
import { normalizeCalendarCase } from './calendar-case.util';

/** Дні тижня й місяці в перекладі — з малої: при читанні з бази і перед записом. */
@EventSubscriber()
export class WordCalendarCaseSubscriber implements EntitySubscriberInterface<Word> {
  listenTo() {
    return Word;
  }

  afterLoad(entity: Word): void {
    normalizeCalendarCase(entity);
  }

  beforeInsert(event: InsertEvent<Word>): void {
    if (event.entity) normalizeCalendarCase(event.entity);
  }

  beforeUpdate(event: UpdateEvent<Word>): void {
    if (event.entity) normalizeCalendarCase(event.entity as Word);
  }
}
