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

    def chat_reply(self, system: str, user: str, temperature: float = 0.8) -> dict:
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
                "options": {"temperature": temperature},
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        return json.loads(response.json()["message"]["content"])


_VERDICT_TOOL = {
    "toolSpec": {
        "name": "submit_verdict",
        "description": "Submit the checklist verdict for this transcript.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["yes", "no", "unclear"]},
                    "confidence": {
                        "type": "integer",
                        "description": "Confidence in this verdict, from 0 (pure guess) to 100 (certain).",
                    },
                    "evidence": {"type": "string", "description": "Short quote from the transcript."},
                },
                "required": ["status", "confidence", "evidence"],
            }
        },
    }
}

_REPLY_TOOL = {
    "toolSpec": {
        "name": "submit_reply",
        "description": "Submit the next line of dialogue for this live conversation.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "human_speaker": {
                        "type": "string",
                        "description": (
                            "Short role label for the FIRST speaker -- whoever asked the question or made "
                            "the statement you are now responding to, e.g. 'Customer' or 'Doctor'."
                        ),
                    },
                    "speaker": {
                        "type": "string",
                        "description": (
                            "Short role label for the SECOND speaker -- you, the one giving the reply -- "
                            "chosen as the natural counterpart to human_speaker, e.g. if human_speaker is "
                            "'Doctor' this should be 'Patient', or if human_speaker is 'Customer' this "
                            "should be 'Agent'. It must be a DIFFERENT role than human_speaker."
                        ),
                    },
                    "reply": {
                        "type": "string",
                        "description": "The one or two sentence spoken reply itself, in character.",
                    },
                },
                "required": ["human_speaker", "speaker", "reply"],
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

    def chat_reply(self, system: str, user: str, temperature: float = 0.8) -> dict:
        response = self.client.converse(
            modelId=self.model_id,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": user}]}],
            toolConfig={
                "tools": [_REPLY_TOOL],
                "toolChoice": {"tool": {"name": "submit_reply"}},
            },
            inferenceConfig={"temperature": temperature},
        )
        for block in response["output"]["message"]["content"]:
            if "toolUse" in block:
                return block["toolUse"]["input"]
        raise ValueError("Bedrock response did not contain a tool use block")
