# syntax=docker/dockerfile:1.7
FROM python:3.12-slim-bookworm@sha256:d193c6f51a7dbd10395d6328de3a7edb0516fb0608ca138036576f574c3e07d2 AS the_dark_side_base

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /work

COPY requirements.txt /tmp/the-dark-side-requirements.txt

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    fonts-liberation \
    nodejs \
    npm \
  && python -m pip install --no-cache-dir --upgrade pip \
  && python -m pip install --no-cache-dir --no-compile -r /tmp/the-dark-side-requirements.txt \
  && groupadd --gid 1000 darkside \
  && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash darkside \
  && rm -rf /var/lib/apt/lists/* /tmp/*

CMD ["bash"]

FROM the_dark_side_base AS the_dark_side_install

USER darkside

CMD ["bash"]

FROM the_dark_side_base AS the_dark_side_check

RUN rm -f \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/bin/npm \
    /usr/bin/npx \
    /usr/bin/corepack \
  && rm -rf \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/share/nodejs/npm \
    /root/.npm \
    /tmp/*

USER darkside

CMD ["bash"]
