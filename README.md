# 👶 Nanny Cam

A free nanny cam / baby monitor that runs in your phone's web browser. No app, no account, no subscription.

- One phone (an old one works great) is the **camera**. Your everyday phone **watches**.
- Video and audio are **end-to-end encrypted** between the phones and never recorded.
- Only phones you **pair** with the camera's secret key can watch.
- Save several cameras and watch them one at a time or all at once. Several phones can watch at the same time.
- Alerts (sound + vibration) for crying/noise, movement, or a lost connection.

Live at: **https://s-chuch.github.io/nanny-cam/**

## Use it

1. **Camera phone:** open the site → **📷 Use this phone as the CAMERA** → allow camera + microphone.
   Prop it up, plug it in, and tap **🌙 Dim screen** if you like.
2. **Pair your phone** (once): on the camera tap **🔗 Share pairing link** and send it to yourself, then open it on your phone.
   Or tap **🔑 Show key** and type the key into **👀 Watch → Add a camera** on your phone.
3. On your phone tap **▶️ Watch** (or **Watch all cameras**). Tap **🔈 Unmute** to hear the room.

## Security — how it works

| Protection | What it means for you |
|---|---|
| **Pairing key** (code + 128‑bit secret) | The secret never leaves your phones — not even the connection server sees it. Without it, nobody can watch, even if they know the camera's code. |
| **Both sides prove themselves** | Your phone checks it's really *your* camera before showing anything, so nobody can fake a feed. |
| **End‑to‑end encryption, verified** | Video is encrypted (WebRTC DTLS‑SRTP). The encryption keys are checked with the secret, so a server in the middle can't secretly decrypt it. The camera sends nothing until this check passes. |
| **You can see who's watching** | The camera shows a **● LIVE — watched by …** banner (even when dimmed), chimes when someone starts watching, and lists each viewer with a **Disconnect** button. |
| **Remove everyone** | **🔒 Remove all viewers** makes a new key. Old links and keys stop working; re-pair the phones you trust. |
| **Wrong-key blocking** | After 5 wrong attempts the camera blocks new connections, for longer each time. |
| **Locked-down page** | Content Security Policy, a pinned + integrity-checked PeerJS library, no tracking, nothing stored online. |

### Keep it safe
- Treat the pairing link/key like a house key. Only send it to people you trust, and delete it from chats afterwards.
- If you ever lose track of who has it (or a phone is lost), tap **🔒 Remove all viewers** and re-pair.
- **Disconnect** only kicks someone for now; they still have the key. Use **Remove all viewers** to lock them out.
- Use this site only from `s-chuch.github.io/nanny-cam/` and don't host other people's pages on `s-chuch.github.io`
  (they would share the same browser storage).

### Why GitHub Pages (and not AWS / Google Cloud)?
Moving the page to AWS or GCP would **not** make it more secure. The page is a fixed file served over HTTPS with no secrets,
and all the security above happens on the phones. Free cloud tiers add a credit card, possible surprise bills (AWS's free
plan now expires), and servers to keep patched.

What third parties see: the free PeerJS server (introduces the phones) and, on some networks, a relay server, can see
*that* two devices connected and their IP addresses — but **not** the video, audio, or your key.

## Good to know
- Both phones need internet (Wi‑Fi or mobile data). Works from anywhere.
- Keep the camera phone's browser **open and on screen** — phones pause the camera if you switch apps or lock it.
- This is a free hobby project; don't rely on it as your only way to watch a child.
