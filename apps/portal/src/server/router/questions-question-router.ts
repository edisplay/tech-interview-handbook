import { z } from 'zod';
import { QuestionsQuestionType, Vote } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { createProtectedRouter } from './context';

import type { Question } from '~/types/questions';
import { SortOrder, SortType } from '~/types/questions.d';

export const questionsQuestionRouter = createProtectedRouter()
  .query('getQuestionsByFilter', {
    input: z.object({
      companyNames: z.string().array(),
      cursor: z
        .object({
          idCursor: z.string().optional(),
          lastSeenCursor: z.date().nullish().optional(),
          upvoteCursor: z.number().optional(),
        })
        .nullish(),
      endDate: z.date().default(new Date()),
      limit: z.number().min(1).default(50),
      locations: z.string().array(),
      questionTypes: z.nativeEnum(QuestionsQuestionType).array(),
      roles: z.string().array(),
      sortOrder: z.nativeEnum(SortOrder),
      sortType: z.nativeEnum(SortType),
      startDate: z.date().optional(),
    }),
    async resolve({ ctx, input }) {
      const { cursor } = input;

      const sortCondition =
        input.sortType === SortType.TOP
          ? [
              {
                upvotes: input.sortOrder,
              },
              {
                id: input.sortOrder,
              },
            ]
          : [
              {
                lastSeenAt: input.sortOrder,
              },
              {
                id: input.sortOrder,
              },
            ];

      const questionsData = await ctx.prisma.questionsQuestion.findMany({
        cursor:
          cursor !== undefined
            ? {
                id: cursor ? cursor!.idCursor : undefined,
              }
            : undefined,
        include: {
          _count: {
            select: {
              answers: true,
              comments: true,
            },
          },
          encounters: {
            select: {
              company: true,
              location: true,
              role: true,
              seenAt: true,
            },
          },
          user: {
            select: {
              name: true,
            },
          },
          votes: true,
        },
        orderBy: sortCondition,
        take: input.limit + 1,
        where: {
          ...(input.questionTypes.length > 0
            ? {
                questionType: {
                  in: input.questionTypes,
                },
              }
            : {}),
          encounters: {
            some: {
              seenAt: {
                gte: input.startDate,
                lte: input.endDate,
              },
              ...(input.companyNames.length > 0
                ? {
                    company: {
                      name: {
                        in: input.companyNames,
                      },
                    },
                  }
                : {}),
              ...(input.locations.length > 0
                ? {
                    location: {
                      in: input.locations,
                    },
                  }
                : {}),
              ...(input.roles.length > 0
                ? {
                    role: {
                      in: input.roles,
                    },
                  }
                : {}),
            },
          },
        },
      });

      const processedQuestionsData = questionsData.map((data) => {
        const votes: number = data.votes.reduce(
          (previousValue: number, currentValue) => {
            let result: number = previousValue;

            switch (currentValue.vote) {
              case Vote.UPVOTE:
                result += 1;
                break;
              case Vote.DOWNVOTE:
                result -= 1;
                break;
            }
            return result;
          },
          0,
        );

        const companyCounts: Record<string, number> = {};
        const locationCounts: Record<string, number> = {};
        const roleCounts: Record<string, number> = {};

        let latestSeenAt = data.encounters[0].seenAt;

        for (let i = 0; i < data.encounters.length; i++) {
          const encounter = data.encounters[i];

          latestSeenAt =
            latestSeenAt < encounter.seenAt ? encounter.seenAt : latestSeenAt;

          if (!(encounter.company!.name in companyCounts)) {
            companyCounts[encounter.company!.name] = 1;
          }
          companyCounts[encounter.company!.name] += 1;

          if (!(encounter.location in locationCounts)) {
            locationCounts[encounter.location] = 1;
          }
          locationCounts[encounter.location] += 1;

          if (!(encounter.role in roleCounts)) {
            roleCounts[encounter.role] = 1;
          }
          roleCounts[encounter.role] += 1;
        }

        const question: Question = {
          aggregatedQuestionEncounters: {
            companyCounts,
            latestSeenAt,
            locationCounts,
            roleCounts,
          },
          content: data.content,
          id: data.id,
          numAnswers: data._count.answers,
          numComments: data._count.comments,
          numVotes: votes,
          receivedCount: data.encounters.length,
          seenAt: latestSeenAt,
          type: data.questionType,
          updatedAt: data.updatedAt,
          user: data.user?.name ?? '',
        };
        return question;
      });

      let nextCursor: typeof cursor | undefined = undefined;

      if (questionsData.length > input.limit) {
        const nextItem = questionsData.pop()!;
        processedQuestionsData.pop();

        const nextIdCursor: string | undefined = nextItem.id;
        const nextLastSeenCursor =
          input.sortType === SortType.NEW ? nextItem.lastSeenAt : undefined;
        const nextUpvoteCursor =
          input.sortType === SortType.TOP ? nextItem.upvotes : undefined;

        nextCursor = {
          idCursor: nextIdCursor,
          lastSeenCursor: nextLastSeenCursor,
          upvoteCursor: nextUpvoteCursor,
        };
      }

      return {
        data: processedQuestionsData,
        nextCursor,
      };
    },
  })
  .query('getQuestionById', {
    input: z.object({
      id: z.string(),
    }),
    async resolve({ ctx, input }) {
      const questionData = await ctx.prisma.questionsQuestion.findUnique({
        include: {
          _count: {
            select: {
              answers: true,
              comments: true,
            },
          },
          encounters: {
            select: {
              company: true,
              location: true,
              role: true,
              seenAt: true,
            },
          },
          user: {
            select: {
              name: true,
            },
          },
          votes: true,
        },
        where: {
          id: input.id,
        },
      });
      if (!questionData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Question not found',
        });
      }
      const votes: number = questionData.votes.reduce(
        (previousValue: number, currentValue) => {
          let result: number = previousValue;

          switch (currentValue.vote) {
            case Vote.UPVOTE:
              result += 1;
              break;
            case Vote.DOWNVOTE:
              result -= 1;
              break;
          }
          return result;
        },
        0,
      );

      const companyCounts: Record<string, number> = {};
      const locationCounts: Record<string, number> = {};
      const roleCounts: Record<string, number> = {};

      let latestSeenAt = questionData.encounters[0].seenAt;

      for (const encounter of questionData.encounters) {
        latestSeenAt =
          latestSeenAt < encounter.seenAt ? encounter.seenAt : latestSeenAt;

        if (!(encounter.company!.name in companyCounts)) {
          companyCounts[encounter.company!.name] = 1;
        }
        companyCounts[encounter.company!.name] += 1;

        if (!(encounter.location in locationCounts)) {
          locationCounts[encounter.location] = 1;
        }
        locationCounts[encounter.location] += 1;

        if (!(encounter.role in roleCounts)) {
          roleCounts[encounter.role] = 1;
        }
        roleCounts[encounter.role] += 1;
      }

      const question: Question = {
        aggregatedQuestionEncounters: {
          companyCounts,
          latestSeenAt,
          locationCounts,
          roleCounts,
        },
        content: questionData.content,
        id: questionData.id,
        numAnswers: questionData._count.answers,
        numComments: questionData._count.comments,
        numVotes: votes,
        receivedCount: questionData.encounters.length,
        seenAt: questionData.encounters[0].seenAt,
        type: questionData.questionType,
        updatedAt: questionData.updatedAt,
        user: questionData.user?.name ?? '',
      };
      return question;
    },
  })
  .query('getRelatedQuestionsByContent', {
    input: z.object({
      content: z.string(),
    }),
    async resolve({ ctx, input }) {
      const escapeChars = /[()|&:*!]/g;

      const query =
        input.content
          .replace(escapeChars, " ")
          .trim()
          .split(/\s+/)
          .join(" | ");

      const relatedQuestions = await ctx.prisma.$queryRaw`
        SELECT * FROM "QuestionsQuestion"
        WHERE
          "contentSearch" @@ to_tsquery('english', ${query})
        ORDER BY ts_rank("textSearch", to_tsquery('english', ${query})) DESC
      `;

      return relatedQuestions;
    }

  })
  .mutation('create', {
    input: z.object({
      companyId: z.string(),
      content: z.string(),
      location: z.string(),
      questionType: z.nativeEnum(QuestionsQuestionType),
      role: z.string(),
      seenAt: z.date(),
    }),
    async resolve({ ctx, input }) {
      const userId = ctx.session?.user?.id;

      return await ctx.prisma.questionsQuestion.create({
        data: {
          content: input.content,
          encounters: {
            create: {
              company: {
                connect: {
                  id: input.companyId,
                },
              },
              location: input.location,
              role: input.role,
              seenAt: input.seenAt,
              user: {
                connect: {
                  id: userId,
                },
              },
            },
          },
          lastSeenAt: input.seenAt,
          questionType: input.questionType,
          userId,
        },
      });
    },
  })
  .mutation('update', {
    input: z.object({
      content: z.string().optional(),
      id: z.string(),
      questionType: z.nativeEnum(QuestionsQuestionType).optional(),
    }),
    async resolve({ ctx, input }) {
      const userId = ctx.session?.user?.id;

      const questionToUpdate = await ctx.prisma.questionsQuestion.findUnique({
        where: {
          id: input.id,
        },
      });

      if (questionToUpdate?.id !== userId) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'User have no authorization to record.',
          // Optional: pass the original error to retain stack trace
        });
      }

      const { content, questionType } = input;

      return await ctx.prisma.questionsQuestion.update({
        data: {
          content,
          questionType,
        },
        where: {
          id: input.id,
        },
      });
    },
  })
  .mutation('delete', {
    input: z.object({
      id: z.string(),
    }),
    async resolve({ ctx, input }) {
      const userId = ctx.session?.user?.id;

      const questionToDelete = await ctx.prisma.questionsQuestion.findUnique({
        where: {
          id: input.id,
        },
      });

      if (questionToDelete?.id !== userId) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'User have no authorization to record.',
          // Optional: pass the original error to retain stack trace
        });
      }

      return await ctx.prisma.questionsQuestion.delete({
        where: {
          id: input.id,
        },
      });
    },
  })
  .query('getVote', {
    input: z.object({
      questionId: z.string(),
    }),
    async resolve({ ctx, input }) {
      const userId = ctx.session?.user?.id;
      const { questionId } = input;

      return await ctx.prisma.questionsQuestionVote.findUnique({
        where: {
          questionId_userId: { questionId, userId },
        },
      });
    },
  })
  .mutation('createVote', {
    input: z.object({
      questionId: z.string(),
      vote: z.nativeEnum(Vote),
    }),
    async resolve({ ctx, input }) {
      const userId = ctx.session?.user?.id;
      const { questionId, vote } = input;

      const incrementValue = vote === Vote.UPVOTE ? 1 : -1;

      const [questionVote] = await ctx.prisma.$transaction([
        ctx.prisma.questionsQuestionVote.create({
          data: {
            questionId,
            userId,
            vote,
          },
        }),
        ctx.prisma.questionsQuestion.update({
          data: {
            upvotes: {
              increment: incrementValue,
            },
          },
          where: {
            id: questionId,
          },
        }),
      ]);
      return questionVote;
    },
  })
  .mutation('updateVote', {
    input: z.object({
      id: z.string(),
      vote: z.nativeEnum(Vote),
    }),
    async resolve({ ctx, input }) {
      const userId = ctx.session?.user?.id;
      const { id, vote } = input;

      const voteToUpdate = await ctx.prisma.questionsQuestionVote.findUnique({
        where: {
          id: input.id,
        },
      });

      if (voteToUpdate?.userId !== userId) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'User have no authorization to record.',
        });
      }

      const incrementValue = vote === Vote.UPVOTE ? 2 : -2;

      const [questionVote] = await ctx.prisma.$transaction([
        ctx.prisma.questionsQuestionVote.update({
          data: {
            vote,
          },
          where: {
            id,
          },
        }),
        ctx.prisma.questionsQuestion.update({
          data: {
            upvotes: {
              increment: incrementValue,
            },
          },
          where: {
            id: voteToUpdate.questionId,
          },
        }),
      ]);

      return questionVote;
    },
  })
  .mutation('deleteVote', {
    input: z.object({
      id: z.string(),
    }),
    async resolve({ ctx, input }) {
      const userId = ctx.session?.user?.id;

      const voteToDelete = await ctx.prisma.questionsQuestionVote.findUnique({
        where: {
          id: input.id,
        },
      });

      if (voteToDelete?.userId !== userId) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'User have no authorization to record.',
        });
      }

      const incrementValue = voteToDelete.vote === Vote.UPVOTE ? -1 : 1;

      const [ questionVote ] = await ctx.prisma.$transaction([
        ctx.prisma.questionsQuestionVote.delete({
          where: {
            id: input.id,
          },
        }),
        ctx.prisma.questionsQuestion.update({
          data: {
            upvotes: {
              increment: incrementValue,
            },
          },
          where: {
            id: voteToDelete.questionId,
          },
        }),
      ]);
      return questionVote;
    },
  });
