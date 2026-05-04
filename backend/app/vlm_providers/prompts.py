"""Shared VLM prompt strings for all providers.

Both CosmosProvider and OpenAIProvider import from here.
"""

PROMPTS: dict[str, str] = {
    "vehicle_collision": (
        "Detect whether this traffic camera clip shows a vehicle collision or collision aftermath. "
        "Confirm if you clearly see any collision evidence: vehicles touching or overlapping, visible damage, broken parts, debris, glass, cargo, smoke, fluid, or a vehicle stopped abnormally in the road, intersection, off-lane, sideways, or against another vehicle. "
        "The impact does not need to be shown; aftermath evidence is enough. "
        "Reject only if traffic appears normal with no visible damage, debris, smoke, fluid, contact, or abnormal stopping. "
        "Use uncertain if the video is blurry, blocked, dark, or the evidence is unclear. "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
    "ped_impact": (
        "You are analyzing a traffic camera clip for a suspected pedestrian impact. "
        "Look for contact or dangerous near-miss between a vehicle and a person. "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
    "stationary_vehicle": (
        "You are analyzing a traffic camera clip for a vehicle stopped in an unusual position. "
        "Is a vehicle blocking a lane, stopped on a shoulder, or parked where it should not be? "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
    "mass_stop": (
        "You are analyzing a traffic camera clip for a sudden mass traffic stop. "
        "Do multiple vehicles brake abruptly or come to an unusual simultaneous stop? "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
}
