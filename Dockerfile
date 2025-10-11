FROM node:lts

# Set working directory
WORKDIR /src

# Install common tools
RUN apt-get update && apt install -y git curl make git-all cmake gcc libssl-dev pkg-config libclang-dev libpq-dev build-essential python3-pip python3-pip-whl protobuf-compiler

# Install Rust globally to /usr/local
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/src/.cargo/bin:/usr/local/cargo/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.3 -LsSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none #&& chmod -R a+w /usr/local/rustup /usr/local/cargo

# Install pnpm globally
RUN npm install -g pnpm @anthropic-ai/claude-code@2.0.1

# Disable bash history
ENV HISTFILE=/dev/null
ENV HISTFILESIZE=0

# Default command
CMD ["/bin/bash"]

