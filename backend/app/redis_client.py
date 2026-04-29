import asyncio
import json
import redis.asyncio as redis


async def stream_events(redis_url: str):
    while True:
        try:
            client = redis.from_url(redis_url, decode_responses=True)
            async with client:
                last_id = "$"
                while True:
                    messages = await client.xread({"mdx-raw": last_id}, block=0)
                    if messages:
                        for stream, msg_list in messages:
                            for msg_id, msg_data in msg_list:
                                last_id = msg_id
                                # DeepStream MDX broker may serialize payload as a JSON string in a "msg" field.
                                # Log the raw shape on first message so the schema can be confirmed on Brev.
                                if last_id and not getattr(stream_events, "_schema_logged", False):
                                    print(f"[redis_client] first mdx-raw message keys: {list(msg_data.keys())}")
                                    stream_events._schema_logged = True  # type: ignore[attr-defined]
                                yield msg_data
        except Exception as e:
            print(f"Redis stream error: {e}")
            await asyncio.sleep(2)


async def clear_stream(redis_url: str) -> None:
    client = redis.from_url(redis_url, decode_responses=True)
    async with client:
        await client.delete("mdx-raw")
