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
                                yield msg_data
        except Exception as e:
            print(f"Redis stream error: {e}")
            await asyncio.sleep(2)


async def clear_stream(redis_url: str) -> None:
    client = redis.from_url(redis_url, decode_responses=True)
    async with client:
        await client.delete("mdx-raw")
