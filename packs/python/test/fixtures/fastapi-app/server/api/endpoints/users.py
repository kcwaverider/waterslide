from fastapi import APIRouter, Depends

from auth import get_current_user
from db import db

router = APIRouter()


@router.get("")
async def list_users(user: str = Depends(get_current_user)):
    return await db.users.find({}).to_list(100)


@router.get("/{user_id}")
async def get_user(user_id: str):
    return await db.users.find_one({"_id": user_id})
