from fastapi import HTTPException

from services import audit, mailer, retry_queue


def handle(note):
    if note.deleted:
        raise HTTPException(status_code=404)
    elif note.locked:
        audit.record(note)
        return None
    else:
        mailer.send(note)
    mailer.send_receipt(note)
    try:
        mailer.deliver(note)
    except TimeoutError:
        retry_queue.enqueue(note)
    x = audit.record(note) if note.big else audit.skip(note)
    match note.kind:
        case "a":
            audit.a(note)
        case _:
            audit.other(note)
    return x


HANDLERS = {"create": audit.record, "delete": audit.purge}


def dispatch(event):
    HANDLERS[event.kind](event)


def local_only(flag):
    if flag:
        value = 1
    else:
        value = 2
    return value
