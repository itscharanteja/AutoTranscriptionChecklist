import asyncio
import base64
import json
import uuid
from typing import AsyncIterator, Optional

import boto3
from aws_sdk_bedrock_runtime.client import AsyncBedrockRuntimeClient, InvokeModelWithBidirectionalStreamOperationInput
from aws_sdk_bedrock_runtime.config import AsyncBedrockRuntimeConfig, HTTPAuthSchemeResolver, SigV4AuthScheme
from aws_sdk_bedrock_runtime.models import BidirectionalInputPayloadPart, InvokeModelWithBidirectionalStreamInputChunk
from smithy_http.aio.crt import AWSCRTHTTPClient

MODEL_ID = "amazon.nova-2-sonic-v1:0"
REGION = "us-east-1"

SYSTEM_PROMPT = (
    "You are a transcription service, not a conversational assistant. Do not reply, answer "
    "questions, or comment on what is said -- only listen."
)


class NovaSonicSession:
    """One live-call's worth of speech-to-text via Nova Sonic's bidirectional stream.

    Opens a single continuous AUDIO content block for the life of the call --
    Nova Sonic's own turn-detection segments that into multiple finalized
    USER-role text segments as natural pauses occur, which callers read via
    `transcripts()`. ASSISTANT output (Nova Sonic is a full speech-to-speech
    model and will try to reply) is intentionally dropped -- this app keeps
    using its own Nova Micro-based reply generation instead.
    """

    def __init__(self):
        self.client: Optional[AsyncBedrockRuntimeClient] = None
        self.stream = None
        self.prompt_name = str(uuid.uuid4())
        self.system_content_name = str(uuid.uuid4())
        self.audio_content_name = str(uuid.uuid4())
        self.is_active = False
        self._transcript_queue: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
        self._reader_task: Optional[asyncio.Task] = None

    async def _config(self) -> AsyncBedrockRuntimeConfig:
        creds = boto3.Session().get_credentials().get_frozen_credentials()
        return await AsyncBedrockRuntimeConfig.resolve(
            endpoint_uri=f"https://bedrock-runtime.{REGION}.amazonaws.com",
            region=REGION,
            aws_access_key_id=creds.access_key,
            aws_secret_access_key=creds.secret_key,
            aws_session_token=creds.token,
            auth_scheme_resolver=HTTPAuthSchemeResolver(),
            auth_schemes={"aws.auth#sigv4": SigV4AuthScheme(service="bedrock")},
            # aiohttp doesn't support HTTP/2 duplex streaming; the CRT transport does.
            transport=AWSCRTHTTPClient(),
        )

    async def _send_event(self, event: dict) -> None:
        chunk = InvokeModelWithBidirectionalStreamInputChunk(
            value=BidirectionalInputPayloadPart(bytes_=json.dumps(event).encode("utf-8"))
        )
        await self.stream.input_stream.send(chunk)

    async def start(self) -> None:
        self.client = AsyncBedrockRuntimeClient(config=await self._config())
        self.stream = await self.client.invoke_model_with_bidirectional_stream(
            InvokeModelWithBidirectionalStreamOperationInput(model_id=MODEL_ID)
        )
        self.is_active = True

        await self._send_event({
            "event": {"sessionStart": {"inferenceConfiguration": {"maxTokens": 1024, "topP": 0.9, "temperature": 0.7}}}
        })
        await self._send_event({
            "event": {
                "promptStart": {
                    "promptName": self.prompt_name,
                    "textOutputConfiguration": {"mediaType": "text/plain"},
                    "audioOutputConfiguration": {
                        "mediaType": "audio/lpcm",
                        "sampleRateHertz": 24000,
                        "sampleSizeBits": 16,
                        "channelCount": 1,
                        "voiceId": "matthew",
                        "encoding": "base64",
                        "audioType": "SPEECH",
                    },
                }
            }
        })
        await self._send_event({
            "event": {
                "contentStart": {
                    "promptName": self.prompt_name,
                    "contentName": self.system_content_name,
                    "type": "TEXT",
                    "interactive": True,
                    "role": "SYSTEM",
                    "textInputConfiguration": {"mediaType": "text/plain"},
                }
            }
        })
        await self._send_event({
            "event": {
                "textInput": {
                    "promptName": self.prompt_name,
                    "contentName": self.system_content_name,
                    "content": SYSTEM_PROMPT,
                }
            }
        })
        await self._send_event({
            "event": {"contentEnd": {"promptName": self.prompt_name, "contentName": self.system_content_name}}
        })

        # One continuous audio block for the whole call -- Nova Sonic segments
        # its own transcription output at natural pauses within this stream.
        await self._send_event({
            "event": {
                "contentStart": {
                    "promptName": self.prompt_name,
                    "contentName": self.audio_content_name,
                    "type": "AUDIO",
                    "interactive": True,
                    "role": "USER",
                    "audioInputConfiguration": {
                        "mediaType": "audio/lpcm",
                        "sampleRateHertz": 16000,
                        "sampleSizeBits": 16,
                        "channelCount": 1,
                        "audioType": "SPEECH",
                        "encoding": "base64",
                    },
                }
            }
        })

        self._reader_task = asyncio.create_task(self._read_loop())

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if not self.is_active or not pcm_bytes:
            return
        blob = base64.b64encode(pcm_bytes).decode("utf-8")
        await self._send_event({
            "event": {
                "audioInput": {
                    "promptName": self.prompt_name,
                    "contentName": self.audio_content_name,
                    "content": blob,
                }
            }
        })

    async def _read_loop(self) -> None:
        role: Optional[str] = None
        try:
            while self.is_active:
                output = await self.stream.await_output()
                result = await output[1].receive()
                if not (result.value and result.value.bytes_):
                    continue
                data = json.loads(result.value.bytes_.decode("utf-8"))
                ev = data.get("event", {})
                if "contentStart" in ev:
                    role = ev["contentStart"].get("role")
                elif "textOutput" in ev and role == "USER":
                    text = ev["textOutput"]["content"].strip()
                    if text:
                        await self._transcript_queue.put(text)
        except Exception:
            pass
        finally:
            await self._transcript_queue.put(None)

    async def transcripts(self) -> AsyncIterator[str]:
        """Yields finalized USER-speech segments as they arrive; ends when the session closes."""
        while True:
            text = await self._transcript_queue.get()
            if text is None:
                return
            yield text

    async def close(self) -> None:
        if not self.is_active:
            return
        self.is_active = False
        try:
            await self._send_event({
                "event": {"contentEnd": {"promptName": self.prompt_name, "contentName": self.audio_content_name}}
            })
            await self._send_event({"event": {"promptEnd": {"promptName": self.prompt_name}}})
            await self._send_event({"event": {"sessionEnd": {}}})
            await self.stream.input_stream.close()
        except Exception:
            pass
        if self._reader_task:
            # Closing the input stream should make the server end the output
            # stream too, letting _read_loop exit on its own; only cancel it
            # forcibly (mid-await on the CRT stream) as a last resort, since
            # that races with the CRT event loop and logs a noisy traceback.
            try:
                await asyncio.wait_for(self._reader_task, timeout=3)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._reader_task.cancel()
