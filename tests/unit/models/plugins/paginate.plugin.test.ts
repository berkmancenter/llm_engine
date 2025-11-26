import mongoose, { Model } from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import paginate from '../../../../src/models/plugins/paginate.plugin.js'
import { PaginateResults } from '../../../../src/types/index.types.js'

interface IProject {
  tasks: Array<ITask>
  name: string
}
interface ProjectModel extends Model<IProject> {
  paginate(filter: unknown, options: unknown): Promise<PaginateResults<IProject>>
}

interface ITask {
  project: mongoose.Types.ObjectId | IProject
  name: string
}
interface TaskModel extends Model<ITask> {
  paginate(filter: unknown, options: unknown): Promise<PaginateResults<ITask>>
}

const projectSchema = new mongoose.Schema<IProject>({
  name: {
    type: String,
    required: true
  }
})

projectSchema.virtual('tasks', {
  ref: 'Task',
  localField: '_id',
  foreignField: 'project'
})

projectSchema.plugin(paginate)
const Project = mongoose.model<IProject, ProjectModel>('Project', projectSchema)

const taskSchema = new mongoose.Schema<ITask>({
  name: {
    type: String,
    required: true
  },
  project: {
    type: mongoose.SchemaTypes.ObjectId,
    ref: 'Project',
    required: true
  }
})

taskSchema.plugin(paginate)
const Task = mongoose.model<ITask, TaskModel>('Task', taskSchema)

setupIntTest()

describe('paginate plugin', () => {
  describe('populate option', () => {
    test('should populate the specified data fields', async () => {
      const project = await Project.create({ name: 'Project One' })
      const task = await Task.create({ name: 'Task One', project: project._id })

      const taskPages = await Task.paginate({ _id: task._id }, { populate: 'project' })

      expect(taskPages.results[0].project).toHaveProperty('_id', project._id)
    })

    test('should populate nested fields', async () => {
      const project = await Project.create({ name: 'Project One' })
      const task = await Task.create({ name: 'Task One', project: project._id })

      const projectPages = await Project.paginate({ _id: project._id }, { populate: 'tasks.project' })
      const { tasks } = projectPages.results[0]

      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toHaveProperty('_id', task._id)
      expect(tasks[0].project).toHaveProperty('_id', project._id)
    })
  })
})
