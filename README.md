# 👶 Nanny Cam

A free nanny cam / baby monitor that runs in your phone's web browser. No app, no account, no subscription.

- One phone (an old one works great) is the **camera**.
- Your everyday phone is the **viewer**.
- Video and audio go directly between the two phones (peer-to-peer WebRTC) — nothing is recorded or stored on a server.
- Viewer gets alerts (sound + vibration) when it hears crying/noise or sees movement.

## Set it up (one time, free)

1. On GitHub, open this repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick **main** and **/ (root)**, then **Save**.
3. After a minute your site is live at:
   `https://<your-github-username>.github.io/nanny-cam/`

## Use it

1. On the **camera phone**, open the site and tap **📷 Use this phone as the CAMERA**. Allow camera + microphone.
   You'll see an 8‑letter code. Prop the phone up and plug it in. Tap **🌙 Dim screen** to make it dark.
2. On **your phone**, open the site, tap **👀 Use this phone to WATCH**, enter the code, and tap **Connect**.
   (Or tap **🔗 Share watch link** on the camera phone and send the link to yourself.)
3. Tap **🔈 Unmute** to hear the room.

Tip: on your phone, use the browser's **Add to Home Screen** so it opens like an app.

## Good to know

- Both phones need internet (Wi‑Fi or mobile data). Works from anywhere, not just at home.
- Keep the camera phone's browser **open and on screen** — phones pause the camera if you switch apps or lock it.
- The code is the key: anyone with it can watch. Tap **♻️ New code** on the camera to change it.
- Uses the free public [PeerJS](https://peerjs.com/) server only to introduce the two phones to each other.
