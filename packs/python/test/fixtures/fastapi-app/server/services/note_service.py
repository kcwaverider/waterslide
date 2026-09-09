import anthropic
from fastapi import HTTPException

from repositories.note_repo import NoteRepository


class NoteService:
    def __init__(self):
        self.repo = NoteRepository()
        self.client = anthropic.AsyncAnthropic(api_key="k")

    async def create(self, note):
        if not note.body:
            raise HTTPException(status_code=400, detail="empty")
        doc = await self.repo.save(note)
        summary = await self.client.messages.create(model="claude", messages=[{"role": "user", "content": note.body}])
        return doc

    async def get(self, note_id):
        return await self.repo.get(note_id)

    async def update(self, note_id, note):
        return await self.repo.save(note)

    async def delete(self, note_id):
        return await self.repo.delete(note_id)

    async def archive(self, note_id):
        return await self.repo.touch(note_id)
