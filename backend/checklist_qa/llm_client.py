import json

import requests


class OllamaClient:
    def __init__(self, model: str = "qwen3:1.7b", host: str = "http://localhost:11434", timeout: int = 120):
        self.model = model
        self.model_name = model
        self.host = host.rstrip("/")
        self.timeout = timeout

    def chat_json(self, system: str, user: str) -> str:
        response = requests.post(
            f"{self.host}/api/chat",
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "format": "json",
                "stream": False,
                "options": {"temperature": 0},
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()["message"]["content"]


_VERDICT_TOOL = {
    "toolSpec": {
        "name": "submit_verdict",
        "description": "Submit the checklist verdict for this transcript.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["yes", "no", "unclear"]},
                    "evidence": {"type": "string", "description": "Short quote from the transcript."},
                },
                "required": ["status", "evidence"],
            }
        },
    }
}


class BedrockClient:
    """Uses the Bedrock Converse API with a forced tool call to get structured
    yes/no/unclear verdicts, instead of relying on the model to format free-text JSON."""

    def __init__(self, model_id: str = "amazon.nova-micro-v1:0", region: str = "us-east-1"):
        import boto3
        from botocore.config import Config

        self.model_id = model_id
        self.model_name = model_id
        self.client = boto3.client(
            "bedrock-runtime",
            region_name=region,
            config=Config(
                max_pool_connections=20,
                retries={"mode": "adaptive"},
                connect_timeout=5,
                read_timeout=30,
            ),
        )

    def chat_json(self, system: str, user: str) -> str:
        response = self.client.converse(
            modelId=self.model_id,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": user}]}],
            toolConfig={
                "tools": [_VERDICT_TOOL],
                "toolChoice": {"tool": {"name": "submit_verdict"}},
            },
            inferenceConfig={"temperature": 0},
        )
        for block in response["output"]["message"]["content"]:
            if "toolUse" in block:
                return json.dumps(block["toolUse"]["input"])
        raise ValueError("Bedrock response did not contain a tool use block")
