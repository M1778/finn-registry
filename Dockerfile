# The CI environment, runnable locally.
#
# Pinned to the same NODE_VERSION as `.github/workflows/deploy.yml`, so that what
# passes here is what CI runs. Keep the two in step.
#
# This pin is why the image exists. It was 20 on both sides until running the
# pipeline in here showed that `wrangler` refuses to start on anything below 22:
# every Verify gate passed on 20 and the deploy would then have failed at the
# first wrangler command. A host running 22 cannot see that.
#
# bookworm rather than alpine on purpose. `workerd` — the runtime `wrangler dev`
# executes the Worker on — ships as a glibc binary, so a musl base cannot run the
# very thing this image exists to test.
FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies in their own layer, keyed on the manifests alone, so editing
# source does not re-resolve the tree.
#
# `npm ci` rather than `npm install` is the point of the exercise: it installs
# strictly from package-lock.json and fails if the lockfile and package.json
# disagree. That check has no equivalent on the host, where installing is
# off-limits.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# wrangler and next both read this to stay non-interactive: no prompts, no
# update notices, no telemetry negotiation on a machine nobody is watching.
ENV CI=true
ENV NEXT_TELEMETRY_DISABLED=1
ENV WRANGLER_SEND_METRICS=false

CMD ["bash", "docker/verify.sh"]
