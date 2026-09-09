from db import db


class NoteRepository:
    async def save(self, note):
        return await db.notes.insert_one(note.dict())

    async def get(self, note_id):
        return await db.notes.find_one({"_id": note_id})

    async def delete(self, note_id):
        await db.notes.delete_one({"_id": note_id})

    async def touch(self, note_id):
        await db.notes.rename("archived_notes")


async def handle_member_exit(db, user_id):
    await db.users.update_one({"_id": user_id}, {"$set": {"active": False}})
