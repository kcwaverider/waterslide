from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user
from services.note_service import NoteService

router = APIRouter(prefix="/notes", tags=["notes"])


class Author(BaseModel):
    user_id: str = Field(..., classification=["identifier"])
    name: str


class NoteCreate(BaseModel):
    body: str = Field(..., json_schema_extra={"classification": ["free_text", "may_contain_pii"]})
    tags: list[str] = []
    author: Optional[Author] = None


class NoteOut(BaseModel):
    note_id: str
    body: str
    author: Author


def require_admin(user: str = Depends(get_current_user)):
    if user != "admin":
        raise HTTPException(status_code=403)
    return user


@router.post("", response_model=NoteOut)
async def create_note(note: NoteCreate, user: str = Depends(get_current_user)):
    svc = NoteService()
    return await svc.create(note)


@router.get("/{note_id}", response_model=NoteOut)
async def get_note(note_id: str, user: str = Depends(get_current_user)):
    svc = NoteService()
    doc = await svc.get(note_id)
    if doc is None:
        raise HTTPException(status_code=404)
    return doc


@router.put("/{note_id}")
async def update_note(note_id: str, note: NoteCreate, user: str = Depends(get_current_user)):
    svc = NoteService()
    return await svc.update(note_id, note)


@router.delete("/{note_id}", dependencies=[Depends(require_admin)])
async def delete_note(note_id: str):
    svc = NoteService()
    await svc.delete(note_id)
    return {"deleted": note_id}


@router.api_route("/{note_id}/archive", methods=["POST", "PATCH"])
async def archive_note(note_id: str, user: str = Depends(get_current_user)):
    svc = NoteService()
    return await svc.archive(note_id)
