import os

from motor.motor_asyncio import AsyncIOMotorClient


class Database:
    def __init__(self):
        self.mongo_client = None
        self.db = None

    async def connect(self):
        self.mongo_client = AsyncIOMotorClient(os.getenv("MONGODB_URL"))
        self.db = self.mongo_client[os.getenv("MONGODB_DB", "fixture_db")]

    async def close(self):
        if self.mongo_client:
            self.mongo_client.close()

    @property
    def notes(self):
        return self.db.notes

    @property
    def users(self):
        return self.db.users


db = Database()
