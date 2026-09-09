from fastapi import APIRouter
from api.endpoints import notes_router, users_router

api_router = APIRouter()
api_router.include_router(notes_router)
api_router.include_router(users_router, prefix="/users")
