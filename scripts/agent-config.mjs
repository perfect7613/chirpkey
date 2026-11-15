// Builds the Bolna agent config for ChirpKey. Used by setup-agent.mjs.
export function buildAgent({ publicUrl, toolsToken, ownerName, targets, graph = false }) {
  const webhookUrl = toolsToken ? `${publicUrl}/webhooks/bolna?token=${toolsToken}` : `${publicUrl}/webhooks/bolna`;
  const auth = toolsToken ? `Bearer ${toolsToken}` : null;
  const tool = (name, description, properties, required, preCall) => ({
    def: { name, description, pre_call_message: preCall, key: "custom_task", parameters: { type: "object", properties, required } },
    params: {
      method: "POST",
      url: `${publicUrl}/tools/${name}`,
      api_token: auth,
      headers: {},
      param: Object.fromEntries(Object.keys(properties).map((k) => [k, `%(${k})s`])),
    },
  });

  const targetList = targets.map((t) => `- ${t.id}: ${t.description}`).join("\n");

  const tools = [
    tool(
      "verify_identity",
      "Verify the caller. Call this as soon as the caller has said their name and their secret phrase. Pass the phrase exactly as heard.",
      {
        name: { type: "string", description: "The caller's name as they said it" },
        secret_phrase: { type: "string", description: "The secret phrase exactly as the caller said it" },
      },
      ["name", "secret_phrase"],
      "One second.",
    ),
    tool(
      "request_action",
      "Send a request to the owner's phone for approval by chirp. Call only after the caller is verified and has confirmed your one-sentence summary of what to do. Every action of any kind (billing, subscriptions, creating or running bots, coding tasks, GPU jobs) goes through this tool.",
      {
        target: { type: "string", description: `Which system should do it. One of: ${targets.map((t) => t.id).join(", ")}. Use grok_bot when unsure.` },
        action: { type: "string", description: "Short imperative title, e.g. 'Cancel Codex subscription' or 'Create a bot that summarises my inbox daily'" },
        details: { type: "string", description: "Everything the executor needs: names, plans, amounts, timing, constraints the caller mentioned" },
      },
      ["target", "action", "details"],
      "Sending that to your phone.",
    ),
    tool(
      "check_action_status",
      "Check whether the latest request was approved on the phone and how it is going. Call it after request_action once the caller says they approved, or when they ask for an update.",
      { action_id: { type: "string", description: "The action_id returned by request_action, or 'latest' if you don't have it" } },
      ["action_id"],
      "Let me check.",
    ),
    tool(
      "set_approval_mode",
      "Switch how requests get approved. Call it when the caller picks a mode, or says things like 'switch to Gibberlink mode', 'agent mode', 'chirp mode', 'voice mode' or 'just do it by voice'.",
      { mode: { type: "string", description: "'gibberlink' (approve with a phone chirp) or 'voice' (the spoken yes on this call is enough)" } },
      ["mode"],
      "Switching.",
    ),
  ];

  const prompt = `You are ChirpKey, ${ownerName ? `${ownerName}'s` : "the owner's"} voice concierge for their AI stack and subscriptions. You speak on a live web call.

# What you can do
You can get things done through these systems:
${targetList}
Routing: cancel, renew, downgrade, upgrade or check subscriptions (Claude, ChatGPT, Cursor, anything) -> grok_bot. Create a new Grok bot or run an existing one -> grok_bot. Fix a bug, write code or review a project on the laptop -> claude_code, or codex if they ask for Codex. For coding tasks, always ask which project if they didn't say, and put it in details. GPU jobs -> gpu. Open a website or app on the laptop, or play music or a video (YouTube Music, YouTube, Spotify, any URL) -> laptop, with the site, app or song in details; never send these to codex or claude_code. You never do anything yourself; you file requests that the owner approves on their phone.

# Flow
1. Identity first. The welcome message already asked for the secret phrase. As soon as you hear anything that could be the phrase, call verify_identity. If it fails, ask again; after it says too many attempts, apologise and end the call. Never reveal, repeat or hint at the phrase. Address the owner as ${ownerName || "the owner"} (speech recognition often mishears names; never use a name you heard).
2. Ask what they want done. Pick the target. Ask a short question only if something that matters is missing (which subscription, which project, which bot).
3. Read back ONE short summary and ask "Shall I send it?". Any yes ("yeah", "yes", "confirm", "do it") means go. Never ask for confirmation twice.
4. Call request_action, then say only: "Check your phone." Then immediately call check_action_status without waiting for them to speak; it waits for the approval.
5. Tell them the result in one sentence. If it is still running (browser and coding tasks take a minute or two), say so; call check_action_status again when they ask.
6. Offer to do something else, or say goodbye.

# Approval modes
- Gibberlink mode (default): requests are approved by a chirp to the owner's phone. Call it "Gibberlink mode".
- Voice mode: the caller's yes after your read-back is the approval; request_action runs it straight away.
- If verify_identity tells you to ask which mode, ask once. The caller can switch any time ("switch to Gibberlink mode", "agent mode", "voice mode"): call set_approval_mode.
- Always follow the request_action response: it tells you whether a chirp is playing or it was approved by voice.

# Noise and side conversations
- Chirps, beeps and garbled words are expected while a request is pending. Ignore them.
- In a demo the owner may talk to other people in the room. If what you hear is not addressed to you (explaining the project, chatting), stay quiet or say "I'm here when you need me." Do not try to act on it.

# Style
- One or two short sentences per turn. Friendly, crisp, no filler.
- Do not read IDs, URLs or JSON aloud.
- If asked whether you are an AI: yes, you are ChirpKey's voice agent.
- Never claim something is done unless check_action_status says done${graph ? " or you were given the result" : ""}.

# Language
- Reply in the caller's language. If they speak Hindi or Hinglish ("mera Codex cancel kar do"), reply in natural Hinglish: Hindi in Devanagari script, with product names and tech words in English (Grok Bot, Claude Code, subscription).
- Tool arguments (action, details) are always written in English.`;

  const graphPrompt = prompt.replace(
    /4\. Call request_action[\s\S]*?(?=6\. )/,
    `4. Call request_action, then say only "Check your phone." and stop. You will be told automatically the moment the phone approves and again when the task finishes; do not call check_action_status unless the caller asks for an update.
5. If the caller asks how it's going, call check_action_status and tell them in one sentence.
`,
  );

  const events = [
    ["action_approved", "approved"],
    ["action_done", "done"],
    ["action_failed", "failed"],
    ["action_denied", "denied"],
  ];
  const eventEdges = events.map(([event_name, to]) => ({ to_node_id: to, condition_type: "event", event_name }));
  const announce = (id, say) => ({
    id,
    prompt: `${say} Speak first, right away, in the caller's language, in one or two short sentences. Do not call any tool. Then wait for the caller.`,
    edges: [...eventEdges.filter((e) => e.to_node_id !== id), { to_node_id: "main", condition: "The caller says anything or asks for something" }],
  });
  const graphLlm = {
    agent_type: "graph_agent",
    agent_flow_type: "streaming",
    llm_config: {
      provider: "openai",
      family: "openai",
      model: "gpt-4.1-mini",
      agent_flow_type: "streaming",
      max_tokens: 200,
      temperature: 0.2,
      routing_provider: "openai",
      routing_model: "gpt-4.1-mini",
      routing_max_tokens: 250,
      routing_instructions:
        "You are the routing system for ChirpKey. Stay on the current node unless an edge clearly matches. From an announcement node, go back to main as soon as the caller says anything.",
      agent_information: graphPrompt,
      current_node_id: "main",
      nodes: [
        {
          id: "main",
          prompt: "Run the ChirpKey flow from the agent information: verify the phrase, take the request, read it back once, call request_action.",
          edges: eventEdges,
        },
        announce("approved", 'The owner just approved "{{action}}" on their phone by chirp. Tell them it is approved and you are handing it to {{target_name}} now.'),
        announce("done", 'The task "{{action}}" just finished. The result is: {{result_summary}}. Tell them the result.'),
        announce("failed", 'The task "{{action}}" failed: {{result_summary}}. Tell them briefly and offer to try again.'),
        announce("denied", 'The owner denied "{{action}}" on their phone. Confirm it was not done and ask if they want anything else.'),
      ],
    },
  };

  return {
    agent_config: {
      agent_name: graph ? "ChirpKey Live (graph + events)" : "ChirpKey Concierge",
      call_summary_enabled: true,
      webhook_url: webhookUrl || null,
      agent_type: "other",
      agent_welcome_message: `Hey${ownerName ? ` ${ownerName.split(" ")[0]}` : ""}, ChirpKey here. What's the secret phrase?`,
      tasks: [
        {
          task_type: "conversation",
          toolchain: { execution: "parallel", pipelines: [["transcriber", "llm", "synthesizer"]] },
          tools_config: {
            llm_agent: graph ? graphLlm : {
              agent_type: "simple_llm_agent",
              agent_flow_type: "streaming",
              llm_config: {
                provider: "openai",
                family: "openai",
                model: "gpt-4.1-mini",
                agent_flow_type: "streaming",
                max_tokens: 200,
                temperature: 0.2,
              },
            },
            synthesizer: {
              provider: "sarvam",
              stream: true,
              caching: true,
              buffer_size: 250,
              audio_format: "wav",
              // Hindi voice so Hinglish replies sound natural; it reads English fine too.
              provider_config: { model: "bulbul:v3", voice: "Priya", voice_id: "priya", language: "hi", speed: 1 },
            },
            transcriber: {
              provider: "deepgram",
              model: "nova-3",
              // Code-switched Hindi + English (Hinglish).
              language: "multi-hi",
              stream: true,
              sampling_rate: 16000,
              encoding: "linear16",
              endpointing: 250,
              // Test calls misheard Grok as "chrome bot" / "crock bot" and the owner's name.
              keywords: ["ChirpKey", "Grok", "Grok Bot", "Codex", "Claude", "Claude Code", "Cursor", "bravo", ownerName]
                .filter(Boolean).join(", "),
            },
            input: { provider: "twilio", format: "wav" },
            output: { provider: "twilio", format: "wav" },
            api_tools: {
              tools: tools.map((t) => t.def),
              tools_params: Object.fromEntries(tools.map((t) => [t.def.name, t.params])),
            },
          },
          task_config: {
            optimize_latency: true,
            hangup_after_silence: 40,
            call_terminate: 900,
            incremental_delay: 400,
            number_of_words_for_interruption: 2,
            check_if_user_online: true,
            check_user_online_message: "Still there?",
            trigger_user_online_message_after: 20,
            backchanneling: false,
            use_fillers: false,
            call_hangup_message: { en: "Talk soon. Bye." },
          },
        },
      ],
    },
    agent_prompts: { task_1: { system_prompt: prompt } },
  };
}
