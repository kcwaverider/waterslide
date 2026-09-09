from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api import api_router
from db import db

app = FastAPI(title="Fixture API")

app.add_middleware(CORSMiddleware, allow_origins=["*"])


@app.on_event("startup")
async def startup():
    await db.connect()


@app.on_event("shutdown")
async def shutdown():
    await db.close()


app.include_router(api_router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
