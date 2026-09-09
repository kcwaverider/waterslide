import anthropic
import boto3
import voyageai
from cohere import ClientV2


class Summarizer:
    def __init__(self, key):
        self.client = anthropic.AsyncAnthropic(api_key=key)
        self.vo = voyageai.AsyncClient(api_key=key)
        self.s3 = boto3.client("s3")
        self.co = ClientV2(api_key=key)

    async def summarize(self, text):
        return await self.client.messages.create(model="m", messages=[{"role": "user", "content": text}])

    async def embed(self, text):
        return await self.vo.embed([text], model="voyage-3")

    def rerank(self, docs):
        return self.co.rerank(query="q", documents=docs)

    def upload(self, data):
        self.s3.put_object(Bucket="b", Key="k", Body=data)


def enqueue(payload):
    boto3.client("sqs").send_message(QueueUrl="https://sqs.example/embed", MessageBody=payload)


def enqueue_dynamic(payload, url):
    boto3.client("sqs").send_message(QueueUrl=url, MessageBody=payload)


class Injected:
    def __init__(self, client):
        self.client = client

    def run(self):
        return self.client.messages.create(model="m")
