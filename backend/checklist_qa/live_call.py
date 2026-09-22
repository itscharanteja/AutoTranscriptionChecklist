from typing import List, Optional, Tuple

from .models import Turn
from .transcript import render_transcript

SYSTEM_PROMPT = (
    "You are taking part in a live, two-person spoken conversation, playing the second speaker -- "
    "the one who responds. Infer from what the first speaker has said what kind of conversation "
    "this is (for example a customer support call, a medical consultation, or something else "
    "entirely), what role the FIRST speaker is playing (e.g. are they asking a question a "
    "customer would ask, or one a doctor would ask?), and what COMPLEMENTARY role you, the "
    "SECOND speaker, should play in response (e.g. the agent answering that customer, or the "
    "patient answering that doctor). Respond only as that inferred second role, in one short, "
    "natural spoken line (one or two sentences) that responds to whatever the first speaker just "
    "said. Invent plausible specific details if needed to answer in character."
)


def generate_reply(
    client,
    turns: List[Turn],
    human_speaker: Optional[str] = None,
    bot_speaker: Optional[str] = None,
) -> Tuple[str, str, str]:
    """Returns (human_speaker_label, bot_speaker_label, reply_text).

    Role labels are inferred by the model only on the first call (when none are
    passed in yet). Once established, the caller passes them back on every later
    call -- the model is told to keep playing that role but its own guess at the
    label fields is ignored, since nothing in a plain transcript tells it which
    label was "its own" on earlier turns, and trusting it there let it swap
    Doctor/Patient (or similar) mid-conversation.
    """
    established = bool(human_speaker and bot_speaker)

    if established:
        transcript_text = render_transcript(turns)
        user_prompt = (
            f"You are playing '{bot_speaker}' and the other person is '{human_speaker}' in this "
            f"conversation.\n\nConversation so far:\n{transcript_text}\n\n"
            f"Respond with the next line of dialogue, staying in character as {bot_speaker}."
        )
    else:
        # No speaker labels exist yet -- show only the raw line(s) said so far, with no
        # placeholder name attached, so a fabricated label like "You" can't bias the model's
        # read of who's asking vs answering.
        lines = "\n".join(f'- "{t.text}"' for t in turns) if turns else "(nothing said yet)"
        user_prompt = (
            f"The first speaker has said the following so far:\n{lines}\n\n"
            "Infer both roles and respond with the next line of dialogue."
        )

    data = client.chat_reply(SYSTEM_PROMPT, user_prompt)
    reply = str(data.get("reply", "")).strip().strip('"')

    if established:
        return human_speaker, bot_speaker, reply

    inferred_human = str(data.get("human_speaker", "")).strip() or "You"
    inferred_bot = str(data.get("speaker", "")).strip() or "Them"
    return inferred_human, inferred_bot, reply
