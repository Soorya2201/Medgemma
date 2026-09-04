import { useEffect, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import { formatPostTime } from '../utils/formatTime';
import { ChatBubbleIcon, CloseIcon, ExternalLinkIcon, ShareIcon, ThumbsUpIcon } from './icons';
import StatusMessage from './StatusMessage';

const client = generateClient<Schema>();

type CommunityTab = 'social' | 'news';
type PostMode = 'anonymous' | 'username';

interface Post {
  id: string;
  authorUsername: string | null;
  anonymous: boolean;
  title: string;
  content: string;
  likes: number;
  createdAt: string;
  isOwner: boolean;
  likedByMe: boolean;
}

interface Comment {
  id: string;
  postId: string;
  authorUsername: string | null;
  anonymous: boolean;
  content: string;
  createdAt: string;
  isOwner: boolean;
}

interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

// Rotating accent colors for news cards — the scraped feed has no thumbnails,
// so each card gets a colored edge instead (cycling, not tied to content).
const NEWS_ACCENTS = ['#b7d97e', '#f5c842', '#78c0d7', '#e8b4b8', '#a8d8a8'];

function PostCard({
  post,
  onLike,
  onDelete,
  expanded,
  onToggleComments,
  comments,
  commentsLoading,
  commentsError,
  commentDraft,
  onCommentDraftChange,
  commentMode,
  onCommentModeChange,
  onSubmitComment,
  commentSaving,
  onDeleteComment,
}: {
  post: Post;
  onLike: (id: string, current: number, likedByMe: boolean) => void;
  onDelete: (id: string) => void;
  expanded: boolean;
  onToggleComments: (id: string) => void;
  comments: Comment[];
  commentsLoading: boolean;
  commentsError: boolean;
  commentDraft: string;
  onCommentDraftChange: (text: string) => void;
  commentMode: PostMode;
  onCommentModeChange: (mode: PostMode) => void;
  onSubmitComment: () => void;
  commentSaving: boolean;
  onDeleteComment: (commentId: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shared, setShared] = useState(false);

  const handleShare = async () => {
    const shareText = `${post.title ? post.title + '\n' : ''}${post.content}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: post.title || 'Immuny Community post', text: shareText });
        return;
      }
    } catch {
      // user cancelled the native share sheet — fall through to clipboard
    }
    try {
      await navigator.clipboard.writeText(shareText);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch (e) {
      console.warn('Share failed', e);
    }
  };

  return (
    <div className="community-post-card">
      <div className="community-post-header">
        <div className="community-avatar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v2h20v-2c0-3.3-6.7-5-10-5z"/>
          </svg>
        </div>
        <div>
          <span className="community-post-author">
            {post.anonymous ? 'Anonymous' : (post.authorUsername ?? 'User')}
          </span>
          <span className="community-post-time">{formatPostTime(post.createdAt)}</span>
        </div>
        {post.isOwner && !confirmDelete && (
          <button
            className="community-delete-btn"
            onClick={() => setConfirmDelete(true)}
            title="Delete post"
          >
            <CloseIcon />
          </button>
        )}
        {post.isOwner && confirmDelete && (
          <div className="delete-confirm-inline">
            <span>Delete?</span>
            <button className="delete-yes-btn" onClick={() => onDelete(post.id)}>Yes</button>
            <button className="delete-no-btn" onClick={() => setConfirmDelete(false)}>No</button>
          </div>
        )}
      </div>

      {post.title && <p className="community-post-title">{post.title}</p>}
      <p className="community-post-content">{post.content}</p>

      <div className="community-post-actions">
        <button
          className={`community-action-btn${post.likedByMe ? ' active' : ''}`}
          onClick={() => onLike(post.id, post.likes, post.likedByMe)}
        >
          <ThumbsUpIcon /> <span>{post.likes > 0 ? post.likes : ''}</span>
        </button>
        <button className="community-action-btn" onClick={() => onToggleComments(post.id)}>
          <ChatBubbleIcon /> <span>Comment{comments.length > 0 ? ` (${comments.length})` : ''}</span>
        </button>
        <button className="community-action-btn" onClick={() => void handleShare()}>
          <ShareIcon /> {shared ? 'Copied!' : 'Share'}
        </button>
      </div>

      {expanded && (
        <div className="community-comments">
          {commentsLoading ? (
            <div className="community-comments-loading">Loading comments…</div>
          ) : commentsError ? (
            <div className="community-comments-empty" style={{ color: '#dc2626' }}>
              Couldn't load comments. Check your connection and reopen this post.
            </div>
          ) : comments.length === 0 ? (
            <div className="community-comments-empty">No comments yet. Be the first to reply.</div>
          ) : (
            comments.map(c => (
              <div key={c.id} className="community-comment-row">
                <div className="community-comment-body">
                  <span className="community-comment-author">
                    {c.anonymous ? 'Anonymous' : (c.authorUsername ?? 'User')}
                  </span>
                  <span className="community-comment-text">{c.content}</span>
                </div>
                {c.isOwner && (
                  <button
                    className="community-comment-delete"
                    onClick={() => onDeleteComment(c.id)}
                    title="Delete comment"
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            ))
          )}
          <div className="comment-mode-row">
            <button
              type="button"
              className={`comment-mode-btn ${commentMode === 'anonymous' ? 'active' : ''}`}
              onClick={() => onCommentModeChange('anonymous')}
            >
              Anonymous
            </button>
            <button
              type="button"
              className={`comment-mode-btn ${commentMode === 'username' ? 'active' : ''}`}
              onClick={() => onCommentModeChange('username')}
            >
              Respond as yourself
            </button>
          </div>
          <div className="community-comment-input-row">
            <input
              type="text"
              value={commentDraft}
              onChange={e => onCommentDraftChange(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !commentSaving && commentDraft.trim() && onSubmitComment()}
              placeholder="Write a comment…"
              className="community-comment-input"
            />
            <button
              className="community-comment-submit"
              onClick={onSubmitComment}
              disabled={!commentDraft.trim() || commentSaving}
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface CommunityPageProps {
  currentUserId: string;
  currentUsername?: string;
}

export default function CommunityPage({ currentUserId, currentUsername }: CommunityPageProps) {
  const [tab, setTab] = useState<CommunityTab>('social');
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [disclaimerSource, setDisclaimerSource] = useState<'post' | 'comment'>('post');
  const [disclaimerUsername, setDisclaimerUsername] = useState('');
  const [communityUsername, setCommunityUsername] = useState<string | null>(
    currentUsername ?? null,
  );

  const [showCreatePost, setShowCreatePost] = useState(false);
  const [postMode, setPostMode] = useState<PostMode>('username');
  const [postTitle, setPostTitle] = useState('');
  const [postContent, setPostContent] = useState('');
  const [postSaving, setPostSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ── Comments ──
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, Comment[]>>({});
  const [commentsLoading, setCommentsLoading] = useState<Record<string, boolean>>({});
  const [commentsError, setCommentsError] = useState<Record<string, boolean>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [commentModeByPost, setCommentModeByPost] = useState<Record<string, PostMode>>({});
  const [commentSaving, setCommentSaving] = useState<Record<string, boolean>>({});

  // ── News ──
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoaded, setNewsLoaded] = useState(false);
  const [newsError, setNewsError] = useState(false);

  const isOwnedByMe = (owner: string | null | undefined) =>
    typeof owner === 'string' && (owner === currentUserId || owner.startsWith(`${currentUserId}::`));

  useEffect(() => {
    (async () => {
      try {
        const [{ data }, { data: likeRows }] = await Promise.all([
          client.models.CommunityPost.list(),
          client.models.PostLike.list({ filter: { userId: { eq: currentUserId } } }),
        ]);
        const likedIds = new Set((likeRows ?? []).map(l => l.postId));
        if (data) {
          const mapped: Post[] = [...data]
            .sort((a, b) => new Date(b.createdAt ?? '').getTime() - new Date(a.createdAt ?? '').getTime())
            .map(p => {
              const owner = (p as Record<string, unknown>).owner as string | null | undefined;
              return {
                id: p.id,
                authorUsername: p.authorUsername ?? null,
                anonymous: p.anonymous ?? false,
                title: p.title,
                content: p.content,
                likes: p.likes ?? 0,
                createdAt: p.createdAt ?? new Date().toISOString(),
                isOwner: isOwnedByMe(owner),
                likedByMe: likedIds.has(p.id),
              };
            });
          setPosts(mapped);
        }
      } catch (e) {
        console.warn('CommunityPage: failed to load posts', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [currentUserId]);

  // Lazy-load news the first time the News tab is opened.
  useEffect(() => {
    if (tab !== 'news' || newsLoaded) return;
    (async () => {
      try {
        const { data } = await client.models.NewsArticle.list();
        const mapped: NewsItem[] = (data ?? [])
          .map(a => ({
            id: a.id,
            title: a.title,
            url: a.url,
            source: a.source ?? 'Allergy News',
            publishedAt: a.publishedAt ?? a.fetchedAt ?? new Date().toISOString(),
          }))
          .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
        setNews(mapped);
      } catch (e) {
        console.warn('CommunityPage: failed to load news', e);
        setNewsError(true);
      } finally {
        setNewsLoaded(true);
      }
    })();
  }, [tab, newsLoaded]);

  const handleContinueDisclaimer = () => {
    if (!disclaimerUsername.trim()) return;
    setCommunityUsername(disclaimerUsername.trim());
    setShowDisclaimer(false);
    if (disclaimerSource === 'post') setShowCreatePost(true);
  };

  const handleCreatePost = async () => {
    if (!postContent.trim()) return;
    const isAnon = postMode === 'anonymous';
    if (!isAnon && !communityUsername) {
      setDisclaimerSource('post');
      setShowDisclaimer(true);
      return;
    }
    setPostSaving(true);
    try {
      const { data: created } = await client.models.CommunityPost.create({
        authorUsername: isAnon ? null : (communityUsername ?? null),
        anonymous: isAnon,
        title: postTitle.trim() || 'Untitled',
        content: postContent.trim(),
        likes: 0,
      });
      if (created) {
        const newPost: Post = {
          id: created.id,
          authorUsername: created.authorUsername ?? null,
          anonymous: created.anonymous ?? false,
          title: created.title,
          content: created.content,
          likes: 0,
          createdAt: created.createdAt ?? new Date().toISOString(),
          isOwner: true,
          likedByMe: false,
        };
        setPosts(prev => [newPost, ...prev]);
      }
      setPostTitle('');
      setPostContent('');
      setShowCreatePost(false);
      setSavedMsg({ type: 'success', text: 'Posted!' });
      setTimeout(() => setSavedMsg(null), 3000);
    } catch (e) {
      console.error('CommunityPage: failed to create post', e);
      setSavedMsg({ type: 'error', text: 'Failed to post' });
      setTimeout(() => setSavedMsg(null), 3000);
    } finally {
      setPostSaving(false);
    }
  };

  // One like per account: gated by the PostLike (postId, userId) composite key —
  // create() fails server-side if that row already exists, so this can't be bypassed
  // by rapid double-clicks even though the optimistic update below is not atomic.
  const handleLike = async (id: string, currentLikes: number, likedByMe: boolean) => {
    if (likedByMe) {
      const newLikes = Math.max(0, currentLikes - 1);
      setPosts(prev => prev.map(p => p.id === id ? { ...p, likes: newLikes, likedByMe: false } : p));
      try {
        await client.models.PostLike.delete({ postId: id, userId: currentUserId });
        await client.models.CommunityPost.update({ id, likes: newLikes });
      } catch (e) {
        console.error('Failed to unlike post', e);
        setPosts(prev => prev.map(p => p.id === id ? { ...p, likes: currentLikes, likedByMe: true } : p));
      }
    } else {
      const newLikes = currentLikes + 1;
      setPosts(prev => prev.map(p => p.id === id ? { ...p, likes: newLikes, likedByMe: true } : p));
      try {
        await client.models.PostLike.create({ postId: id, userId: currentUserId });
        await client.models.CommunityPost.update({ id, likes: newLikes });
      } catch (e) {
        console.error('Failed to like post (already liked?)', e);
        setPosts(prev => prev.map(p => p.id === id ? { ...p, likes: currentLikes, likedByMe: true } : p));
      }
    }
  };

  const handleDelete = async (id: string) => {
    setPosts(prev => prev.filter(p => p.id !== id));
    try {
      await client.models.CommunityPost.delete({ id });
    } catch (e) {
      console.error('Failed to delete post', e);
    }
  };

  const toggleComments = async (postId: string) => {
    const opening = expandedPostId !== postId;
    setExpandedPostId(opening ? postId : null);
    if (opening && !commentsByPost[postId]) {
      setCommentsLoading(prev => ({ ...prev, [postId]: true }));
      setCommentsError(prev => ({ ...prev, [postId]: false }));
      try {
        const { data } = await client.models.PostComment.list({ filter: { postId: { eq: postId } } });
        const mapped: Comment[] = (data ?? [])
          .sort((a, b) => new Date(a.createdAt ?? '').getTime() - new Date(b.createdAt ?? '').getTime())
          .map(c => {
            const owner = (c as Record<string, unknown>).owner as string | null | undefined;
            return {
              id: c.id,
              postId: c.postId,
              authorUsername: c.authorUsername ?? null,
              anonymous: c.anonymous ?? false,
              content: c.content,
              createdAt: c.createdAt ?? new Date().toISOString(),
              isOwner: isOwnedByMe(owner),
            };
          });
        setCommentsByPost(prev => ({ ...prev, [postId]: mapped }));
      } catch (e) {
        console.warn('Failed to load comments', e);
        setCommentsError(prev => ({ ...prev, [postId]: true }));
      } finally {
        setCommentsLoading(prev => ({ ...prev, [postId]: false }));
      }
    }
  };

  const submitComment = async (postId: string) => {
    const text = (commentDrafts[postId] ?? '').trim();
    if (!text) return;
    const isAnon = (commentModeByPost[postId] ?? 'username') === 'anonymous';
    if (!isAnon && !communityUsername) {
      setDisclaimerSource('comment');
      setShowDisclaimer(true);
      return;
    }
    setCommentSaving(prev => ({ ...prev, [postId]: true }));
    try {
      const { data: created } = await client.models.PostComment.create({
        postId,
        authorUsername: isAnon ? null : communityUsername,
        anonymous: isAnon,
        content: text,
      });
      if (created) {
        const newComment: Comment = {
          id: created.id,
          postId,
          authorUsername: created.authorUsername ?? null,
          anonymous: created.anonymous ?? false,
          content: created.content,
          createdAt: created.createdAt ?? new Date().toISOString(),
          isOwner: true,
        };
        setCommentsByPost(prev => ({ ...prev, [postId]: [...(prev[postId] ?? []), newComment] }));
      }
      setCommentDrafts(prev => ({ ...prev, [postId]: '' }));
    } catch (e) {
      console.error('Failed to add comment', e);
    } finally {
      setCommentSaving(prev => ({ ...prev, [postId]: false }));
    }
  };

  const deleteComment = async (postId: string, commentId: string) => {
    setCommentsByPost(prev => ({
      ...prev,
      [postId]: (prev[postId] ?? []).filter(c => c.id !== commentId),
    }));
    try {
      await client.models.PostComment.delete({ id: commentId });
    } catch (e) {
      console.error('Failed to delete comment', e);
    }
  };

  if (showDisclaimer) {
    return (
      <div className="community-screen">
        <div className="community-top-bar">
          <button className="community-back" onClick={() => setShowDisclaimer(false)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        </div>
        <div className="disclaimer-body">
          <h2 className="disclaimer-title">Disclaimer</h2>
          <p>Always double check information in the Community Forum.</p>
          <p>Any person is free to use the Community Forum. It is meant for opinions and is to be used like a social media app. Not all users are experts.</p>
          <p>To use the Community Forum, you must enter a username. You can change whether or not your posts and comments use this username or your provided name in account settings.</p>
          <p>By entering a username and continuing you agree to Immuny's <strong>Community Terms and Conditions</strong>.</p>
          <input
            type="text"
            value={disclaimerUsername}
            onChange={e => setDisclaimerUsername(e.target.value)}
            placeholder="Enter Username"
            className="disclaimer-username-input"
          />
          <button
            className="disclaimer-continue-btn"
            onClick={handleContinueDisclaimer}
            disabled={!disclaimerUsername.trim()}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (showCreatePost) {
    return (
      <div className="community-screen">
        <div className="community-top-bar">
          <button className="community-back" onClick={() => setShowCreatePost(false)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        </div>
        <div className="create-post-body">
          <h2 className="create-post-title">Create a Post</h2>
          <p className="create-post-hint">
            If you stay Anonymous, your username will not show on your post.
          </p>
          <div className="post-mode-row">
            <button
              className={`post-mode-btn ${postMode === 'anonymous' ? 'active' : ''}`}
              onClick={() => setPostMode('anonymous')}
            >
              Anonymous
            </button>
            <button
              className={`post-mode-btn ${postMode === 'username' ? 'active' : ''}`}
              onClick={() => setPostMode('username')}
            >
              Username
            </button>
          </div>
          <input
            type="text"
            value={postTitle}
            onChange={e => setPostTitle(e.target.value)}
            placeholder="Add a title…"
            className="create-post-title-input"
          />
          <textarea
            value={postContent}
            onChange={e => setPostContent(e.target.value)}
            placeholder="Add a description…"
            className="create-post-body-input"
            rows={8}
          />
          <button
            className="create-post-submit"
            onClick={() => void handleCreatePost()}
            disabled={!postContent.trim() || postSaving}
          >
            {postSaving ? 'Posting…' : 'Post'}
          </button>
          {savedMsg && (
            <p style={{ textAlign: 'center', marginTop: 10 }}>
              <StatusMessage type={savedMsg.type} text={savedMsg.text} />
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="community-screen">
      <div className="community-header">
        <h1 className="community-title">Community</h1>
        <button className="community-search-btn" title="Search">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </button>
      </div>

      <div className="community-tabs">
        <button
          className={`community-tab ${tab === 'social' ? 'active' : ''}`}
          onClick={() => setTab('social')}
        >
          Social
        </button>
        <button
          className={`community-tab ${tab === 'news' ? 'active' : ''}`}
          onClick={() => setTab('news')}
        >
          News
        </button>
      </div>

      {savedMsg && (
        <div className="community-toast">
          <StatusMessage type={savedMsg.type} text={savedMsg.text} />
        </div>
      )}

      {tab === 'social' && (
        <div className="community-feed">
          <button
            className="community-compose-prompt"
            onClick={() => {
              if (!communityUsername) {
                setDisclaimerSource('post');
                setShowDisclaimer(true);
              } else {
                setShowCreatePost(true);
              }
            }}
          >
            <div className="community-avatar">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v2h20v-2c0-3.3-6.7-5-10-5z"/>
              </svg>
            </div>
            <span>What's on your mind?</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>

          {loading ? (
            <div className="community-loading">Loading posts…</div>
          ) : posts.length === 0 ? (
            <div className="community-empty">
              <p>No posts yet. Be the first to share!</p>
            </div>
          ) : (
            posts.map(post => (
              <PostCard
                key={post.id}
                post={post}
                onLike={handleLike}
                onDelete={handleDelete}
                expanded={expandedPostId === post.id}
                onToggleComments={toggleComments}
                comments={commentsByPost[post.id] ?? []}
                commentsLoading={!!commentsLoading[post.id]}
                commentsError={!!commentsError[post.id]}
                commentDraft={commentDrafts[post.id] ?? ''}
                onCommentDraftChange={text => setCommentDrafts(prev => ({ ...prev, [post.id]: text }))}
                commentMode={commentModeByPost[post.id] ?? 'username'}
                onCommentModeChange={mode => setCommentModeByPost(prev => ({ ...prev, [post.id]: mode }))}
                onSubmitComment={() => void submitComment(post.id)}
                commentSaving={!!commentSaving[post.id]}
                onDeleteComment={commentId => void deleteComment(post.id, commentId)}
              />
            ))
          )}
        </div>
      )}

      {tab === 'news' && (
        <div className="community-news-feed">
          {!newsLoaded ? (
            <div className="community-loading">Loading allergy news…</div>
          ) : newsError ? (
            <div className="community-empty">
              <p>Couldn't load news right now. Try again later.</p>
            </div>
          ) : news.length === 0 ? (
            <div className="community-empty">
              <p>No allergy news yet — check back soon.</p>
            </div>
          ) : (
            news.map((item, i) => (
              <a
                key={item.id}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="news-card"
              >
                <div className="news-card-accent" style={{ background: NEWS_ACCENTS[i % NEWS_ACCENTS.length] }} />
                <div className="news-card-body">
                  <h3 className="news-title">{item.title}</h3>
                  <span className="news-meta">
                    {formatPostTime(item.publishedAt)} | {item.source}
                  </span>
                </div>
                <span className="news-card-link-icon"><ExternalLinkIcon /></span>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}
