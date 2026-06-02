const BaseActivity = require('../base');
const { buildCloud, normalizeText, containsProfanity } = require('./textUtils');

/**
 * WordCloudActivity — a live audience word cloud.
 *
 * Participants submit short text responses from their phones; the big screen
 * renders an ever-updating cloud where more frequent terms appear larger.
 * This is the MVP of the maintainer's `docs/better-word-cloud-prd.md`:
 * live submissions, classic cloud, basic duplicate merging, host moderation,
 * and CSV export (the screen serialises the raw responses this class exposes).
 *
 * The activity is intentionally additive: it plugs into the existing
 * BaseActivity lifecycle and Socket.io plumbing without touching the jigsaw mode.
 */
class WordCloudActivity extends BaseActivity {
  constructor(roomCode, config, roomManager) {
    super(roomCode, config, roomManager);

    this.prompt = String(config.prompt || 'Describe today in one word').slice(0, 200);
    // Per-response character limit (PRD response formats: 1 word / phrase / sentence).
    this.maxChars = Math.min(parseInt(config.maxChars, 10) || 80, 280);
    // How many times a single participant may contribute.
    this.maxSubmissions = Math.max(parseInt(config.maxSubmissions, 10) || 3, 1);
    this.profanityFilter = config.profanityFilter !== false; // on by default

    this.responses = [];                 // full ordered history (see _makeResponse)
    this.submissionCounts = new Map();   // participantId -> count
    this.votes = new Map();              // word -> upvote count
    this.voterWords = new Map();         // participantId -> Set(words already voted)
    this._seq = 0;
  }

  onStart() {
    console.log(
      `Starting Word Cloud Activity for room ${this.roomCode} — prompt: "${this.prompt}"`
    );
  }

  // No per-player setup is required for the word cloud.
  onPlayerJoin() {}
  onPlayerLeave() {}

  onPlayerAction(player, actionType, actionData) {
    if (actionType === 'submit-response') {
      return this.handleSubmission(player, actionData);
    }
    if (actionType === 'vote-word') {
      return this.handleVote(player, actionData);
    }
    return null;
  }

  handleSubmission(player, { text } = {}) {
    if (typeof text !== 'string') {
      return { success: false, error: 'Invalid response.' };
    }

    const trimmed = text.trim().replace(/\s+/g, ' ').slice(0, this.maxChars);
    if (!trimmed) {
      return { success: false, error: 'Response cannot be empty.' };
    }

    const used = this.submissionCounts.get(player.id) || 0;
    if (used >= this.maxSubmissions) {
      return { success: false, error: 'You have used all your submissions.' };
    }

    const normalized = normalizeText(trimmed);
    const hidden = this.profanityFilter && containsProfanity(normalized);

    const response = this._makeResponse(player, trimmed, normalized, hidden);
    this.responses.push(response);
    this.submissionCounts.set(player.id, used + 1);

    return {
      success: true,
      hidden,
      remaining: this.maxSubmissions - (used + 1),
      screenState: this.getStateForScreen()
    };
  }

  /**
   * Upvote a word that is currently in the cloud. Each participant may upvote a
   * given word once; the server is the source of truth for the dedup.
   */
  handleVote(player, { word } = {}) {
    if (typeof word !== 'string') return { success: false, error: 'Invalid vote.' };
    const w = word.toLowerCase().trim();
    if (!w) return { success: false, error: 'Invalid vote.' };

    // Only allow voting for words that actually appear in the current cloud.
    const cloudWords = new Set(buildCloud(this.visibleResponses).map(e => e.word));
    if (!cloudWords.has(w)) return { success: false, error: 'That word is no longer available.' };

    let voted = this.voterWords.get(player.id);
    if (!voted) { voted = new Set(); this.voterWords.set(player.id, voted); }
    if (voted.has(w)) return { success: false, error: 'You already upvoted that word.' };

    voted.add(w);
    this.votes.set(w, (this.votes.get(w) || 0) + 1);
    return { success: true, screenState: this.getStateForScreen() };
  }

  /** Close the activity and return a summary for the reveal screen. */
  close() {
    this.onEnd(); // sets status = 'completed', completedAt
    return this.getSummary();
  }

  getSummary() {
    const cloud = buildCloud(this.visibleResponses, this.votes);
    return {
      prompt: this.prompt,
      topWords: cloud.slice(0, 10),
      totalResponses: this.visibleResponses.length,
      uniqueParticipants: this.submissionCounts.size,
      totalVotes: [...this.votes.values()].reduce((a, b) => a + b, 0)
    };
  }

  /**
   * Hide a response from the cloud (host moderation). Soft-delete so the action
   * is reversible and the raw record is still available for export/audit.
   */
  removeResponse(responseId) {
    const response = this.responses.find(r => r.id === responseId);
    if (!response) return { success: false, error: 'Response not found.' };
    response.status = 'hidden';
    return { success: true, screenState: this.getStateForScreen() };
  }

  _makeResponse(player, text, normalizedText, hidden) {
    return {
      id: `resp_${++this._seq}`,
      participantId: player.id,
      displayName: player.displayName,
      color: player.color,
      text,
      normalizedText,
      status: hidden ? 'hidden' : 'visible',
      createdAt: new Date().toISOString()
    };
  }

  get visibleResponses() {
    return this.responses.filter(r => r.status === 'visible');
  }

  getStateForScreen() {
    const visible = this.visibleResponses;
    return {
      status: this.status,
      prompt: this.prompt,
      maxChars: this.maxChars,
      maxSubmissions: this.maxSubmissions,
      totalResponses: visible.length,
      uniqueParticipants: this.submissionCounts.size,
      cloud: buildCloud(visible, this.votes),
      // Raw rows power the live feed ticker and the client-side CSV export.
      responses: visible.map(r => ({
        id: r.id,
        text: r.text,
        displayName: r.displayName,
        color: r.color,
        createdAt: r.createdAt
      }))
    };
  }

  getStateForPlayer(playerId) {
    const used = this.submissionCounts.get(playerId) || 0;
    return {
      status: this.status,
      prompt: this.prompt,
      maxChars: this.maxChars,
      maxSubmissions: this.maxSubmissions,
      submitted: used,
      remaining: Math.max(this.maxSubmissions - used, 0)
    };
  }

  getProgress() {
    // A word cloud has no "completion"; surface participation instead so the
    // existing Redis room sync still has a meaningful number to store.
    return this.visibleResponses.length;
  }
}

module.exports = WordCloudActivity;
